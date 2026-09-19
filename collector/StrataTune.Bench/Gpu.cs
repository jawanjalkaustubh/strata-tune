using SharpGen.Runtime;
using Vortice.Direct3D;
using Vortice.Direct3D12;
using Vortice.Direct3D12.Debug;
using Vortice.DXGI;
using Vortice.Mathematics;

namespace StrataTune.Bench;

/// <summary>Device, direct queue, flip-model swapchain with three buffers, one command list
/// with an allocator per buffer, a fence value per buffer and a GPU timestamp pair per buffer.
/// A frame slot is reused only once its fence has passed, so at most three frames are in flight.</summary>
internal sealed unsafe class Gpu : IDisposable
{
    public const int FrameCount = 3;
    public const Format ColorFormat = Format.R8G8B8A8_UNorm;
    public const Format DepthFormat = Format.D32_Float;

    private readonly IDXGIFactory6 factory;
    private readonly IDXGIAdapter1 adapter;
    private readonly ID3D12CommandQueue queue;
    private readonly IDXGISwapChain3 swapChain;
    private readonly ID3D12Resource[] backBuffers = new ID3D12Resource[FrameCount];
    private readonly ID3D12DescriptorHeap rtvHeap;
    private readonly ID3D12DescriptorHeap dsvHeap;
    private readonly ID3D12Resource depth;
    private readonly ID3D12CommandAllocator[] allocators = new ID3D12CommandAllocator[FrameCount];
    private readonly ID3D12Fence fence;
    private readonly AutoResetEvent fenceEvent = new(false);
    private readonly ulong[] slotFence = new ulong[FrameCount];
    private readonly int[] slotSegment = new int[FrameCount];
    private readonly ID3D12QueryHeap timestamps;
    private readonly ID3D12Resource timestampReadback;
    private readonly ulong* stamps;
    private readonly double ticksToMs;
    private readonly uint rtvSize;
    private readonly bool tearing;
    private readonly ID3D12InfoQueue? infoQueue;
    private ulong nextFence = 1;
    private int slot;

    public ID3D12Device2 Device { get; }
    public ID3D12GraphicsCommandList List { get; }
    public int Width { get; }
    public int Height { get; }
    public string Name { get; }
    public long Luid { get; }
    public ulong DedicatedVideoMemory { get; }

    /// <summary>The back-buffer index of the frame between BeginFrame and EndFrame.</summary>
    public int Slot => slot;

    /// <summary>The render-target view of that back buffer, for a pass that draws elsewhere first.</summary>
    public CpuDescriptorHandle CurrentBackBufferView => Rtv(slot);

    /// <exception cref="NoHardwareAdapterException">Only WARP or nothing was found.</exception>
    public Gpu(nint hwnd, int width, int height, string? luid, bool debug)
    {
        Width = width;
        Height = height;

        // Without the Graphics Tools feature there is no debug layer, and asking DXGI for one is an invalid call.
        bool layers = false;
        if (debug && D3D12.D3D12GetDebugInterface(out ID3D12Debug? layer).Success)
        {
            layer!.EnableDebugLayer();
            layer.Dispose();
            layers = true;
        }

        factory = DXGI.CreateDXGIFactory2<IDXGIFactory6>(layers);
        adapter = PickAdapter(factory, luid);
        AdapterDescription1 description = adapter.Description1;
        Name = description.Description;
        Luid = ((long)description.Luid.HighPart << 32) | description.Luid.LowPart;
        DedicatedVideoMemory = description.DedicatedVideoMemory;

        D3D12.D3D12CreateDevice(adapter, FeatureLevel.Level_11_0, out ID3D12Device2? device).CheckError();
        Device = device!;
        infoQueue = layers ? Device.QueryInterfaceOrNull<ID3D12InfoQueue>() : null;
        queue = Device.CreateCommandQueue(CommandListType.Direct);

        tearing = factory.PresentAllowTearing;
        SwapChainDescription1 swapDescription = new((uint)width, (uint)height, ColorFormat, false, Usage.RenderTargetOutput, FrameCount,
            Scaling.Stretch, SwapEffect.FlipDiscard, AlphaMode.Ignore, tearing ? SwapChainFlags.AllowTearing : SwapChainFlags.None);
        using (IDXGISwapChain1 created = factory.CreateSwapChainForHwnd(queue, hwnd, swapDescription))
        {
            swapChain = created.QueryInterface<IDXGISwapChain3>();
        }
        factory.MakeWindowAssociation(hwnd, WindowAssociationFlags.IgnoreAltEnter);

        rtvHeap = Device.CreateDescriptorHeap(new DescriptorHeapDescription(DescriptorHeapType.RenderTargetView, FrameCount));
        rtvSize = Device.GetDescriptorHandleIncrementSize(DescriptorHeapType.RenderTargetView);
        for (int i = 0; i < FrameCount; i++)
        {
            backBuffers[i] = swapChain.GetBuffer<ID3D12Resource>((uint)i);
            Device.CreateRenderTargetView(backBuffers[i], null, Rtv(i));
            allocators[i] = Device.CreateCommandAllocator(CommandListType.Direct);
        }

        dsvHeap = Device.CreateDescriptorHeap(new DescriptorHeapDescription(DescriptorHeapType.DepthStencilView, 1));
        depth = Device.CreateCommittedResource(HeapType.Default,
            ResourceDescription.Texture2D(DepthFormat, (uint)width, (uint)height, 1, 1, 1, 0, ResourceFlags.AllowDepthStencil),
            ResourceStates.DepthWrite, new ClearValue(DepthFormat, 1.0f));
        Device.CreateDepthStencilView(depth, null, dsvHeap.GetCPUDescriptorHandleForHeapStart());

        List = Device.CreateCommandList<ID3D12GraphicsCommandList>(CommandListType.Direct, allocators[0]);
        List.Close();
        fence = Device.CreateFence();

        timestamps = Device.CreateQueryHeap<ID3D12QueryHeap>(new QueryHeapDescription(QueryHeapType.Timestamp, FrameCount * 2));
        timestampReadback = Device.CreateCommittedResource(HeapType.Readback, ResourceDescription.Buffer(FrameCount * 2 * sizeof(ulong)), ResourceStates.CopyDest);
        stamps = timestampReadback.Map<ulong>(0);
        queue.GetTimestampFrequency(out ulong frequency).CheckError();
        ticksToMs = 1000.0 / frequency;
    }

    /// <summary>Waits for the slot the next back buffer needs, resets its allocator and opens the
    /// list on a cleared render target. Returns the GPU time of the frame that last used this
    /// slot (three frames ago) with the segment it belonged to, or null on the first pass.</summary>
    public (int Segment, double GpuMs)? BeginFrame()
    {
        slot = (int)swapChain.CurrentBackBufferIndex;
        (int, double)? previous = null;

        if (slotFence[slot] != 0)
        {
            WaitFor(slotFence[slot]);
            previous = (slotSegment[slot], (stamps[slot * 2 + 1] - stamps[slot * 2]) * ticksToMs);
        }

        allocators[slot].Reset();
        List.Reset(allocators[slot], null);
        List.EndQuery(timestamps, QueryType.Timestamp, (uint)(slot * 2));
        List.ResourceBarrierTransition(backBuffers[slot], ResourceStates.Present, ResourceStates.RenderTarget);
        CpuDescriptorHandle rtv = Rtv(slot);
        CpuDescriptorHandle dsv = dsvHeap.GetCPUDescriptorHandleForHeapStart();
        List.OMSetRenderTargets(rtv, dsv);
        List.ClearRenderTargetView(rtv, new Color4(0.05f, 0.06f, 0.09f, 1));
        List.ClearDepthStencilView(dsv, ClearFlags.Depth, 1.0f, 0);
        List.RSSetViewport(0, 0, Width, Height);
        List.RSSetScissorRect(Width, Height);
        return previous;
    }

    public void EndFrame(int segment, bool vsync)
    {
        List.ResourceBarrierTransition(backBuffers[slot], ResourceStates.RenderTarget, ResourceStates.Present);
        List.EndQuery(timestamps, QueryType.Timestamp, (uint)(slot * 2 + 1));
        List.ResolveQueryData(timestamps, QueryType.Timestamp, (uint)(slot * 2), 2, timestampReadback, (ulong)(slot * 2 * sizeof(ulong)));
        List.Close();
        queue.ExecuteCommandList(List);

        Result presented = vsync ? swapChain.Present(1, PresentFlags.None) : swapChain.Present(0, tearing ? PresentFlags.AllowTearing : PresentFlags.None);
        if (presented.Failure)
        {
            throw new SharpGenException(presented, "Present failed");
        }

        slotFence[slot] = nextFence;
        slotSegment[slot] = segment;
        queue.Signal(fence, nextFence++).CheckError();
    }

    /// <summary>A frame that never touches the swapchain, for work that must not be paced by
    /// Present (FillRate.cs): a window the desktop composes rather than flips has its presents
    /// throttled to the display's refresh, which would time the compositor, not the card. The
    /// slot ring turns on its own here and the fence still bounds frames in flight at FrameCount;
    /// a presented frame in between takes whichever slot its back buffer has, as always.</summary>
    public void BeginOffscreen()
    {
        slot = (slot + 1) % FrameCount;
        if (slotFence[slot] != 0)
        {
            WaitFor(slotFence[slot]);
        }

        allocators[slot].Reset();
        List.Reset(allocators[slot], null);
    }

    public void EndOffscreen()
    {
        List.Close();
        queue.ExecuteCommandList(List);
        slotFence[slot] = nextFence;
        queue.Signal(fence, nextFence++).CheckError();
    }

    /// <summary>The value the next EndFrame signals: work recorded now is finished once it has passed.</summary>
    public ulong PendingFence => nextFence;

    public void WaitFor(ulong value)
    {
        if (fence.CompletedValue < value)
        {
            fence.SetEventOnCompletion(value, fenceEvent).CheckError();
            fenceEvent.WaitOne();
        }
    }

    public void WaitIdle()
    {
        queue.Signal(fence, nextFence).CheckError();
        WaitFor(nextFence++);
    }

    // TDR surfaces as one of these DXGI codes on the call after the hang, or as the device's own
    // removed reason once anything has failed; either way the run is over and exit 10 says why.
    public bool IsDeviceRemoved(Exception exception) =>
        exception is SharpGenException e && (IsRemovalCode(e.ResultCode) || Device.DeviceRemovedReason.Failure);

    public string DeviceRemovedReason => Device.DeviceRemovedReason.ToString();

    // With --debug, everything the validation layer stored goes to stderr at the end of the run.
    private void DrainDebugMessages()
    {
        if (infoQueue is null)
        {
            return;
        }

        for (ulong i = 0; i < infoQueue.NumStoredMessages; i++)
        {
            Message message = infoQueue.GetMessage(i);
            Console.Error.WriteLine($"d3d12 {message.Severity} {message.Id}: {message.Description}");
        }
        infoQueue.ClearStoredMessages();
    }

    private static bool IsRemovalCode(Result code) =>
        code == Vortice.DXGI.ResultCode.DeviceRemoved || code == Vortice.DXGI.ResultCode.DeviceHung
        || code == Vortice.DXGI.ResultCode.DeviceReset || code == Vortice.DXGI.ResultCode.DriverInternalError;

    private CpuDescriptorHandle Rtv(int index) => new(rtvHeap.GetCPUDescriptorHandleForHeapStart(), index, rtvSize);

    // DXGI high-performance order, first hardware adapter wins. WARP carries the Software flag and
    // is refused rather than benched, because a run on it says nothing about the card.
    private static IDXGIAdapter1 PickAdapter(IDXGIFactory6 factory, string? luid)
    {
        for (uint i = 0; factory.EnumAdapterByGpuPreference(i, GpuPreference.HighPerformance, out IDXGIAdapter1? candidate).Success; i++)
        {
            AdapterDescription1 description = candidate!.Description1;
            long candidateLuid = ((long)description.Luid.HighPart << 32) | description.Luid.LowPart;
            bool hardware = (description.Flags & AdapterFlags.Software) == 0 && D3D12.IsSupported(candidate, FeatureLevel.Level_11_0);

            if (hardware && (luid is null || candidateLuid.ToString() == luid))
            {
                return candidate;
            }

            candidate.Dispose();
        }

        throw new NoHardwareAdapterException(luid is null ? "no DX12 hardware adapter was found" : $"--adapter: no hardware adapter with luid {luid}");
    }

    public void Dispose()
    {
        DrainDebugMessages();
        infoQueue?.Dispose();
        timestampReadback.Unmap(0);
        timestampReadback.Dispose();
        timestamps.Dispose();
        fence.Dispose();
        fenceEvent.Dispose();
        List.Dispose();
        foreach (ID3D12CommandAllocator allocator in allocators)
        {
            allocator.Dispose();
        }
        depth.Dispose();
        dsvHeap.Dispose();
        foreach (ID3D12Resource buffer in backBuffers)
        {
            buffer.Dispose();
        }
        rtvHeap.Dispose();
        swapChain.Dispose();
        queue.Dispose();
        Device.Dispose();
        adapter.Dispose();
        factory.Dispose();
    }
}

internal sealed class NoHardwareAdapterException(string message) : Exception(message);
