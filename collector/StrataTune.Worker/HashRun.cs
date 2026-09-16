using System.Diagnostics;
using System.Runtime.InteropServices;
using ComputeSharp;

namespace StrataTune.Worker;

internal readonly record struct HashResult(ulong Hash, int Dispatches, TimeSpan Elapsed, long BytesTouched, long Steps);

internal static class HashRun
{
    // D3D12 allows 65535 thread groups per axis and DefaultThreadGroupSizes.X is 64 threads.
    private const int MaxSlice = 65535 * 64;

    // One dispatch is also capped in element-rounds so it stays far below the 2 s TDR budget
    // even on a weak adapter: 2^26 lowbias32 steps is well under a millisecond on a 5090 and
    // ~10 ms per dispatch on WARP, the slowest adapter here. The work is spread over many
    // dispatches inside one ComputeContext with a barrier between them, which is the "heavy"
    // pattern. A fixed constant is only safe because this kernel's cost per step is known;
    // the bandwidth and heavy kernels must size their dispatches from a timed warm-up
    // instead (dependencies.md: measured throughput, not fixed iteration counts).
    private const long StepsPerDispatch = 1L << 26;

    private const int ReadbackChunk = 1 << 22;

    public static HashResult Run(GraphicsDevice device, int elements, int rounds, uint seed)
    {
        int slice = Math.Min(elements, MaxSlice);
        int roundsPerDispatch = (int)Math.Clamp(StepsPerDispatch / slice, 1, rounds);
        int dispatches = 0;
        int passes = 0;

        using ReadWriteBuffer<uint> slots = device.AllocateReadWriteBuffer<uint>(elements, AllocationMode.Clear);

        // The driver compiles the DXIL on the first dispatch of a process (~150 ms cold, then
        // served from its cache); a zero-round pass leaves the data untouched and keeps that
        // out of the timing.
        device.For(slice, new HashKernel(slots, 0, seed, 0, 0));

        long started = Stopwatch.GetTimestamp();

        // Disposing the context executes the command list and waits on the fence.
        using (ComputeContext context = device.CreateComputeContext())
        {
            for (int first = 0; first < rounds; first += roundsPerDispatch)
            {
                uint count = (uint)Math.Min(roundsPerDispatch, rounds - first);

                for (int offset = 0; offset < elements; offset += slice)
                {
                    context.For(Math.Min(slice, elements - offset), new HashKernel(slots, offset, seed, (uint)first, count));
                    context.Barrier(slots);
                    dispatches++;
                }

                passes++;
            }
        }

        TimeSpan elapsed = Stopwatch.GetElapsedTime(started);

        return new HashResult(
            Fold(slots, elements),
            dispatches,
            elapsed,
            BytesTouched: 2L * sizeof(uint) * elements * passes,
            Steps: (long)elements * rounds);
    }

    // FNV-1a 64 over the little-endian bytes of the buffer, read back in chunks so a large
    // run never needs one managed array the size of the GPU buffer.
    private static ulong Fold(ReadWriteBuffer<uint> slots, int elements)
    {
        uint[] chunk = new uint[Math.Min(ReadbackChunk, elements)];
        ulong hash = 0xCBF29CE484222325;

        for (int offset = 0; offset < elements; offset += chunk.Length)
        {
            Span<uint> span = chunk.AsSpan(0, Math.Min(chunk.Length, elements - offset));

            slots.CopyTo(span, offset);

            foreach (byte b in MemoryMarshal.AsBytes(span))
            {
                hash = (hash ^ b) * 0x100000001B3;
            }
        }

        return hash;
    }
}
