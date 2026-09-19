using ComputeSharp;

namespace StrataTune.Worker;

/// <summary>
/// One 16-byte element per thread, read from one buffer and written to another: the plain
/// stream copy every memory-bandwidth figure on a spec sheet is compared against. uint4
/// rather than uint so each thread moves a full 16-byte transaction and the card is bound
/// by its memory bus, not by its issue rate. Timing-only.
/// </summary>
[ThreadGroupSize(DefaultThreadGroupSizes.X)]
[GeneratedComputeShaderDescriptor]
public readonly partial struct BandwidthKernel : IComputeShader
{
    private readonly ReadOnlyBuffer<UInt4> source;
    private readonly ReadWriteBuffer<UInt4> destination;
    private readonly int offset;

    public BandwidthKernel(ReadOnlyBuffer<UInt4> source, ReadWriteBuffer<UInt4> destination, int offset)
    {
        this.source = source;
        this.destination = destination;
        this.offset = offset;
    }

    public void Execute()
    {
        int index = offset + ThreadIds.X;

        destination[index] = source[index];
    }
}
