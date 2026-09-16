using System.Numerics;
using System.Reflection;
using System.Runtime.InteropServices;
using Vortice.D3DCompiler;
using Vortice.Direct3D;
using Vortice.Direct3D12;

namespace StrataTune.Bench;

/// <summary>The scene of Scene.hlsl: a background pass (the heavy pass in the GPU-load segment)
/// and 4096 instanced cubes. HLSL is compiled once at start-up; pipeline states for the shader
/// variants are created on demand, which is the driver compile the shader-compile segment wants.</summary>
internal sealed unsafe class Scene : IDisposable
{
    public const uint InstanceCount = 4096;
    private const uint GridSide = 16;
    private const int ConstantSlotBytes = 256;
    private const string Profile = "5_0";

    [StructLayout(LayoutKind.Sequential)]
    private struct FrameConstants
    {
        public Matrix4x4 ViewProj;
        public float Time;
        public uint InstanceCount;
        public uint GridSide;
        public uint HeavyIterations;
        public Vector2 Resolution;
        public Vector2 Padding;
    }

    private readonly ID3D12Device2 device;
    private readonly ID3D12RootSignature rootSignature;
    private readonly ID3D12PipelineState background;
    private readonly ID3D12PipelineState cubes;
    private readonly ReadOnlyMemory<byte> cubeVertexShader;
    private readonly Queue<ReadOnlyMemory<byte>> pendingVariants = new();
    private readonly List<ID3D12PipelineState> variants = [];
    private readonly ID3D12Resource constants;
    private readonly byte* constantsMapped;
    private readonly Vector2 resolution;

    public int PipelineStates => variants.Count;

    public Scene(ID3D12Device2 device, int width, int height, int variantCount)
    {
        this.device = device;
        resolution = new Vector2(width, height);

        RootSignatureDescription1 signature = new(RootSignatureFlags.None,
        [
            new RootParameter1(RootParameterType.ConstantBufferView, new RootDescriptor1(0, 0), ShaderVisibility.All),
            new RootParameter1(new RootConstants(1, 0, 1), ShaderVisibility.Vertex),
        ]);
        rootSignature = device.CreateRootSignature(signature);

        string source = ShaderSource();
        ShaderMacro[] plain = [new ShaderMacro("VARIANT", 0), new ShaderMacro("SALT", 0)];
        background = Pipeline(Compile(source, plain, "BackgroundVS", "vs"), Compile(source, plain, "BackgroundPS", "ps"), depth: false);
        cubeVertexShader = Compile(source, plain, "CubeVS", "vs");
        cubes = Pipeline(cubeVertexShader, Compile(source, plain, "CubePS", "ps"), depth: true);

        // A fresh salt per run keeps every variant out of the driver's on-disk shader cache, so
        // the second run compiles as much as the first; the base shaders above stay cacheable.
        uint salt = (uint)Random.Shared.Next(1, int.MaxValue);
        for (int i = 1; i <= variantCount; i++)
        {
            pendingVariants.Enqueue(Compile(source, [new ShaderMacro("VARIANT", i), new ShaderMacro("SALT", $"{salt}u")], "CubePS", "ps"));
        }

        constants = device.CreateCommittedResource(HeapType.Upload, ResourceDescription.Buffer(Gpu.FrameCount * ConstantSlotBytes), ResourceStates.GenericRead);
        constantsMapped = constants.Map<byte>(0);
    }

    /// <summary>Turns the next <paramref name="count"/> precompiled variants into pipeline states, on this thread, now.</summary>
    public void CompilePipelineStates(int count)
    {
        while (count-- > 0 && pendingVariants.TryDequeue(out ReadOnlyMemory<byte> pixelShader))
        {
            variants.Add(Pipeline(cubeVertexShader, pixelShader, depth: true));
        }
    }

    public void Draw(ID3D12GraphicsCommandList list, int slot, float time, uint heavyIterations)
    {
        FrameConstants frame = new()
        {
            ViewProj = Matrix4x4.CreateLookAt(new Vector3(MathF.Cos(time * 0.2f) * 100, 40, MathF.Sin(time * 0.2f) * 100), Vector3.Zero, Vector3.UnitY)
                * Matrix4x4.CreatePerspectiveFieldOfView(MathF.PI / 3.6f, resolution.X / resolution.Y, 1, 500),
            Time = time,
            InstanceCount = InstanceCount,
            GridSide = GridSide,
            HeavyIterations = heavyIterations,
            Resolution = resolution,
        };
        *(FrameConstants*)(constantsMapped + slot * ConstantSlotBytes) = frame;

        list.SetGraphicsRootSignature(rootSignature);
        list.SetGraphicsRootConstantBufferView(0, constants.GPUVirtualAddress + (ulong)(slot * ConstantSlotBytes));
        list.IASetPrimitiveTopology(PrimitiveTopology.TriangleList);

        list.SetPipelineState(background);
        list.DrawInstanced(3, 1, 0, 0);

        if (variants.Count == 0)
        {
            list.SetPipelineState(cubes);
            list.SetGraphicsRoot32BitConstant(1, 0u, 0);
            list.DrawInstanced(36, InstanceCount, 0, 0);
            return;
        }

        // Once variants exist the cubes are shared out across them, so every compiled state is drawn every frame.
        uint slice = (InstanceCount + (uint)variants.Count - 1) / (uint)variants.Count;
        for (int i = 0; i < variants.Count; i++)
        {
            uint first = (uint)i * slice;
            if (first >= InstanceCount)
            {
                break;
            }

            list.SetPipelineState(variants[i]);
            list.SetGraphicsRoot32BitConstant(1, first, 0);
            list.DrawInstanced(36, Math.Min(slice, InstanceCount - first), 0, 0);
        }
    }

    private ID3D12PipelineState Pipeline(ReadOnlyMemory<byte> vertexShader, ReadOnlyMemory<byte> pixelShader, bool depth)
    {
        GraphicsPipelineStateDescription description = new()
        {
            RootSignature = rootSignature,
            VertexShader = vertexShader,
            PixelShader = pixelShader,
            BlendState = BlendDescription.Opaque,
            SampleMask = uint.MaxValue,
            RasterizerState = RasterizerDescription.CullNone,
            DepthStencilState = depth ? DepthStencilDescription.Default : DepthStencilDescription.None,
            PrimitiveTopologyType = PrimitiveTopologyType.Triangle,
            RenderTargetFormats = [Gpu.ColorFormat],
            DepthStencilFormat = Gpu.DepthFormat,
            SampleDescription = Vortice.DXGI.SampleDescription.Default,
        };
        return device.CreateGraphicsPipelineState(description);
    }

    private static ReadOnlyMemory<byte> Compile(string source, ShaderMacro[] macros, string entryPoint, string stage) =>
        Compiler.Compile(source, macros, entryPoint, "Scene.hlsl", $"{stage}_{Profile}", ShaderFlags.OptimizationLevel3);

    private static string ShaderSource()
    {
        using Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("Scene.hlsl")
            ?? throw new InvalidOperationException("Scene.hlsl is not embedded in this build");
        using StreamReader reader = new(stream);
        return reader.ReadToEnd();
    }

    public void Dispose()
    {
        constants.Unmap(0);
        constants.Dispose();
        foreach (ID3D12PipelineState variant in variants)
        {
            variant.Dispose();
        }
        cubes.Dispose();
        background.Dispose();
        rootSignature.Dispose();
    }
}
