using Vortice.Direct3D12;
using Vortice.DXGI;

namespace StrataTune.Bench;

/// <summary>The texture-stream segment: bursts of 64 MiB textures committed in VRAM and filled
/// from one pre-filled upload buffer on the graphics queue, so a burst is one long frame of
/// allocation plus PCIe traffic and the card's memory use climbs toward the --vram-target.</summary>
internal sealed unsafe class Streaming : IDisposable
{
    public const uint TextureSize = 4096;
    public const ulong TextureBytes = TextureSize * TextureSize * 4;
    private const int MaxPerBurst = 256;

    private readonly ID3D12Device2 device;
    private readonly ResourceDescription description;
    private readonly ID3D12Resource upload;
    private readonly PlacedSubresourceFootPrint footprint;
    private readonly List<ID3D12Resource> textures = [];
    private ulong lastBurstFence;

    public int PerBurst { get; }
    public int Uploaded { get; private set; }
    public ulong UploadedBytes => (ulong)Uploaded * TextureBytes;

    public Streaming(ID3D12Device2 device, ulong dedicatedVideoMemory, int vramTargetPercent, int bursts)
    {
        this.device = device;
        description = ResourceDescription.Texture2D(Format.R8G8B8A8_UNorm, TextureSize, TextureSize, 1, 1);

        PlacedSubresourceFootPrint[] layouts = new PlacedSubresourceFootPrint[1];
        device.GetCopyableFootprints(description, 0, 1, 0, layouts, new uint[1], new ulong[1], out ulong totalBytes);
        footprint = layouts[0];

        upload = device.CreateCommittedResource(HeapType.Upload, ResourceDescription.Buffer(totalBytes), ResourceStates.GenericRead);
        Fill(upload.Map<uint>(0), totalBytes / sizeof(uint));
        upload.Unmap(0);

        double target = dedicatedVideoMemory * (vramTargetPercent / 100.0);
        PerBurst = (int)Math.Clamp(Math.Ceiling(target / TextureBytes / bursts), 1, MaxPerBurst);
    }

    /// <summary>Records one burst: new textures plus their uploads, all in the current frame's list.
    /// <paramref name="fence"/> is the value that frame will signal, so Release knows when the copies are done.</summary>
    public void RecordBurst(ID3D12GraphicsCommandList list, ulong fence)
    {
        for (int i = 0; i < PerBurst; i++)
        {
            ID3D12Resource texture = device.CreateCommittedResource(HeapType.Default, description, ResourceStates.CopyDest);
            list.CopyTextureRegion(new TextureCopyLocation(texture, 0), 0, 0, 0, new TextureCopyLocation(upload, footprint));
            textures.Add(texture);
        }

        Uploaded += PerBurst;
        lastBurstFence = fence;
    }

    /// <summary>Frees every streamed texture once the GPU has finished the last burst, so the
    /// segments after texture-stream run with the memory they started with. Safe to call repeatedly.</summary>
    public void Release(Gpu gpu)
    {
        if (textures.Count == 0)
        {
            return;
        }

        gpu.WaitFor(lastBurstFence);
        foreach (ID3D12Resource texture in textures)
        {
            texture.Dispose();
        }
        textures.Clear();
    }

    // A texture of noise rather than zeros: the driver cannot skip or compress the copy.
    private static void Fill(uint* data, ulong count)
    {
        uint state = 0x53545241;
        for (ulong i = 0; i < count; i++)
        {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            data[i] = state;
        }
    }

    public void Dispose()
    {
        foreach (ID3D12Resource texture in textures)
        {
            texture.Dispose();
        }
        upload.Dispose();
    }
}
