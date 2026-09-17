using System.Diagnostics;
using Vortice.Direct3D;
using Vortice.Direct3D12;
using Vortice.DXGI;
using Vortice.Mathematics;

namespace StrataTune.Bench;

/// <summary>The --fillrate mode (plan section 8, the missing-ROPs cross-check): full-screen
/// quads into a 32-bit offscreen target with a constant-colour pixel shader, no blend and no
/// depth, as fast as the card writes pixels, for a fixed number of seconds after a warm-up.
/// The one number it prints is pixels per wall second. It is deliberately NVML-free: the
/// caller (the collector's load runner) samples the SM clock while this runs, and
/// src/analysis/gpuUnits.ts divides the two, because one 32-bit pixel per ROP per clock is
/// the raster back end's ceiling, so pixels/s over clock estimates the ROP count.
/// The measured frames never go through the swapchain (Gpu.BeginOffscreen): the audit
/// launches this from the collector while Strata Tune holds the foreground, so the window
/// comes up behind it and the desktop composes it, and a composed window's Present is
/// throttled to the display's refresh — at 60 Hz that is ~64 GPixel/s, a tenth of the card,
/// and the cross-check would answer "did not reach the raster limit" every time. The window
/// is presented on its own slow beat only to show the run is alive.</summary>
internal sealed class FillRate : IDisposable
{
    /// <summary>16.8 Mpixel RGBA8 (64 MiB): large enough that a quad is thousands of raster tiles
    /// on every GPC, small enough for any DX12 card.</summary>
    public const int TargetSize = 4096;
    /// <summary>About 1.07 Gpixel per frame: ~2 ms on an RTX 5090 at its 176 ROPs, ~70 ms on an
    /// 8-ROP laptop part, either far under the 2 s TDR budget with three frames in flight.</summary>
    public const int QuadsPerFrame = 64;
    private const double WarmUpSeconds = 1;
    /// <summary>The window is presented at most this often: a compositor at 60 Hz never queues a present at 20 Hz, so Present returns at once and paces nothing.</summary>
    private const double PresentIntervalSeconds = 0.05;

    // A handful of colours cycled per quad, so the window shows the run is alive and the
    // target is never written with the value it already holds.
    private static readonly Color4[] Palette =
    [
        new(0.10f, 0.45f, 0.30f, 1), new(0.15f, 0.30f, 0.55f, 1), new(0.55f, 0.35f, 0.10f, 1), new(0.40f, 0.15f, 0.45f, 1),
    ];

    private readonly ID3D12RootSignature rootSignature;
    private readonly ID3D12PipelineState pipeline;
    private readonly ID3D12Resource target;
    private readonly ID3D12DescriptorHeap rtvHeap;

    public FillRate(ID3D12Device2 device)
    {
        // Four root constants (the colour) for the pixel shader; no tables, no buffers.
        RootSignatureDescription1 signature = new(RootSignatureFlags.None,
            [new RootParameter1(new RootConstants(0, 0, 4), ShaderVisibility.Pixel)]);
        rootSignature = device.CreateRootSignature(signature);

        string source = Scene.ShaderSource("Fill.hlsl");
        GraphicsPipelineStateDescription description = new()
        {
            RootSignature = rootSignature,
            VertexShader = Scene.Compile(source, [], "FillVS", "vs", "Fill.hlsl"),
            PixelShader = Scene.Compile(source, [], "FillPS", "ps", "Fill.hlsl"),
            BlendState = BlendDescription.Opaque,
            SampleMask = uint.MaxValue,
            RasterizerState = RasterizerDescription.CullNone,
            DepthStencilState = DepthStencilDescription.None,
            PrimitiveTopologyType = PrimitiveTopologyType.Triangle,
            RenderTargetFormats = [Gpu.ColorFormat],
            DepthStencilFormat = Format.Unknown,
            SampleDescription = SampleDescription.Default,
        };
        pipeline = device.CreateGraphicsPipelineState(description);

        target = device.CreateCommittedResource(HeapType.Default,
            ResourceDescription.Texture2D(Gpu.ColorFormat, TargetSize, TargetSize, 1, 1, 1, 0, ResourceFlags.AllowRenderTarget),
            ResourceStates.RenderTarget, new ClearValue(Gpu.ColorFormat, Palette[0]));
        rtvHeap = device.CreateDescriptorHeap(new DescriptorHeapDescription(DescriptorHeapType.RenderTargetView, 1));
        device.CreateRenderTargetView(target, null, rtvHeap.GetCPUDescriptorHandleForHeapStart());
    }

    /// <summary>Warm-up frames until the clocks are up, then measured frames until the seconds
    /// are over and the queue has drained, so every counted pixel was written inside the
    /// measured span. Esc or the close button ends the run with <c>completed: false</c>.</summary>
    public static FillRateSummary Run(int seconds, Window window, Gpu gpu, FillRate fill, Func<bool> cancelled)
    {
        long origin = Stopwatch.GetTimestamp();
        long lastPresent = origin;
        int frame = 0;

        // False once Esc, the close button or Ctrl+C ended the run; nothing is submitted then.
        // A measured frame is offscreen; the window gets its own small frame on the slow beat.
        bool Frame()
        {
            window.Pump();
            if (window.Closed || cancelled())
            {
                return false;
            }

            if (Stopwatch.GetElapsedTime(lastPresent).TotalSeconds >= PresentIntervalSeconds)
            {
                lastPresent = Stopwatch.GetTimestamp();
                gpu.BeginFrame();
                fill.DrawAlive(gpu.List, frame, gpu.CurrentBackBufferView, gpu.Width, gpu.Height);
                gpu.EndFrame(0, vsync: false);
            }

            gpu.BeginOffscreen();
            fill.Draw(gpu.List, frame++);
            gpu.EndOffscreen();
            return true;
        }

        bool alive = true;
        while (alive && Stopwatch.GetElapsedTime(origin).TotalSeconds < WarmUpSeconds)
        {
            alive = Frame();
        }

        // The queue is empty at the start and again at the end, so the span holds exactly the frames counted.
        gpu.WaitIdle();
        long start = Stopwatch.GetTimestamp();
        int measured = 0;
        while (alive && Stopwatch.GetElapsedTime(start).TotalSeconds < seconds)
        {
            alive = Frame();
            if (alive)
            {
                measured++;
            }
        }
        gpu.WaitIdle();
        double span = Stopwatch.GetElapsedTime(start).TotalSeconds;

        double pixels = (double)measured * QuadsPerFrame * TargetSize * TargetSize;
        return new FillRateSummary(
            span > 0 ? Math.Round(pixels / span) : 0,
            Math.Round(span, 3),
            measured,
            TargetSize,
            TargetSize,
            alive);
    }

    /// <summary>The measured work: the quads into the offscreen target, nothing else.</summary>
    private void Draw(ID3D12GraphicsCommandList list, int frame)
    {
        list.SetGraphicsRootSignature(rootSignature);
        list.SetPipelineState(pipeline);
        list.IASetPrimitiveTopology(PrimitiveTopology.TriangleList);
        list.OMSetRenderTargets(rtvHeap.GetCPUDescriptorHandleForHeapStart(), null);
        list.RSSetViewport(0, 0, TargetSize, TargetSize);
        list.RSSetScissorRect(TargetSize, TargetSize);
        for (int quad = 0; quad < QuadsPerFrame; quad++)
        {
            Colour(list, Palette[(frame * QuadsPerFrame + quad) % Palette.Length]);
            list.DrawInstanced(3, 1, 0, 0);
        }
    }

    /// <summary>One quad into the window's own back buffer, under a megapixel and uncounted, so the window shows the run is alive.</summary>
    private void DrawAlive(ID3D12GraphicsCommandList list, int frame, CpuDescriptorHandle backBuffer, int width, int height)
    {
        list.SetGraphicsRootSignature(rootSignature);
        list.SetPipelineState(pipeline);
        list.IASetPrimitiveTopology(PrimitiveTopology.TriangleList);
        list.OMSetRenderTargets(backBuffer, null);
        list.RSSetViewport(0, 0, width, height);
        list.RSSetScissorRect(width, height);
        Colour(list, Palette[frame % Palette.Length]);
        list.DrawInstanced(3, 1, 0, 0);
    }

    private static void Colour(ID3D12GraphicsCommandList list, Color4 colour)
    {
        list.SetGraphicsRoot32BitConstant(0, BitConverter.SingleToUInt32Bits(colour.R), 0);
        list.SetGraphicsRoot32BitConstant(0, BitConverter.SingleToUInt32Bits(colour.G), 1);
        list.SetGraphicsRoot32BitConstant(0, BitConverter.SingleToUInt32Bits(colour.B), 2);
        list.SetGraphicsRoot32BitConstant(0, BitConverter.SingleToUInt32Bits(colour.A), 3);
    }

    public void Dispose()
    {
        rtvHeap.Dispose();
        target.Dispose();
        pipeline.Dispose();
        rootSignature.Dispose();
    }
}
