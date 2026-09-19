using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Serialization;
using ComputeSharp;

namespace StrataTune.Worker;

/// <summary>The one JSON line of <c>--bench --json</c>; member order is the wire order.</summary>
internal sealed record BenchResult(
    string Device,
    string Luid,
    long BufferBytes,
    double BandwidthGBs,
    double BandwidthMedianGBs,
    int MatmulN,
    double MatmulTflopsFp32,
    double MatmulTflopsFp16storage,
    double ElapsedMs,
    [property: JsonIgnore] int BandwidthPasses)
{
    public string ToJson() => JsonSerializer.Serialize(this, BenchJson.Default.BenchResult);
}

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(BenchResult))]
internal sealed partial class BenchJson : JsonSerializerContext;

/// <summary>
/// The measured rows of the advisor's AI stats card (plan section 10): memory bandwidth from
/// a stream copy and matmul TFLOPS on the shader cores, both timing-only. The bandwidth
/// half is what the tune's stage-2 regression check (section 16) reads later.
/// </summary>
internal static class BenchRun
{
    public const int DefaultSeconds = 3;
    public const int MatmulN = 4096;
    public const int MatmulRuns = 5;

    private const int PreferredBytes = 1 << 30;
    private const int FallbackBytes = 1 << 29;
    private const int ElementBytes = 16;

    // 65535 groups x 64 threads, each moving 16 bytes: 64 MiB read and 64 MiB written per
    // dispatch. A fixed slice is safe here because the cost is bound by bytes, not
    // iterations: an adapter would have to move under 70 MB/s to reach the 2 s TDR budget.
    private const int Slice = 65535 * 64;
    private const int FillElements = 1 << 20;
    private const int MaxSweepsPerPass = 64;
    private const int MaxRepeats = 64;
    private static readonly TimeSpan PassTarget = TimeSpan.FromMilliseconds(20);
    private static readonly TimeSpan DispatchTarget = TimeSpan.FromMilliseconds(100);
    private static readonly TimeSpan RunTarget = TimeSpan.FromMilliseconds(100);

    public static BenchResult Run(GraphicsDevice device, int seconds)
    {
        long started = Stopwatch.GetTimestamp();

        (long bytes, List<double> rates) = Bandwidth(device, seconds);

        float[] a = Matrix(MatmulN, 0x53545241);
        float[] b = Matrix(MatmulN, 0x54554E45);
        double fp32 = Matmul(device, a, b, halfStorage: false);
        double fp16 = Matmul(device, a, b, halfStorage: true);

        return new BenchResult(
            device.Name,
            device.Luid.ToString(),
            bytes,
            Math.Round(rates[^1], 1),
            Math.Round(rates[rates.Count / 2], 1),
            MatmulN,
            Math.Round(fp32, 2),
            Math.Round(fp16, 2),
            Math.Round(Stopwatch.GetElapsedTime(started).TotalMilliseconds),
            rates.Count);
    }

    /// <summary>The stream copy alone, for the ladder's stage-2 number: the buffer size it
    /// got (1 GiB, or 512 MiB on a card that cannot hold the pair) and every pass's GB/s sorted.</summary>
    public static (long Bytes, List<double> SortedGBs) Bandwidth(GraphicsDevice device, int seconds)
    {
        (ReadOnlyBuffer<UInt4> source, ReadWriteBuffer<UInt4> destination) = AllocatePair(device);

        using (source)
        using (destination)
        {
            Fill(source);

            int elements = source.Length;
            long bytesPerSweep = 2L * elements * ElementBytes;

            // The first dispatch of a process pays for the driver's DXIL compile; one untimed
            // sweep takes that hit. The second sizes the passes: about 20 ms of work under one
            // fence keeps the submit and fence round trip near one percent, and it is short
            // enough that the budget holds ~150 passes. The best-of figure is a tail sample
            // and needs that many: with 40 ms passes it wandered 4 % between runs on the
            // 5090 while the median stood still; with 20 ms it repeats to 0.2 %.
            Sweep(device, source, destination, 1);
            TimeSpan probe = Sweep(device, source, destination, 1);
            int sweeps = (int)Math.Clamp(PassTarget.Ticks / Math.Max(probe.Ticks, 1), 1, MaxSweepsPerPass);

            List<double> rates = [];
            long deadline = Stopwatch.GetTimestamp() + seconds * Stopwatch.Frequency;

            do
            {
                TimeSpan took = Sweep(device, source, destination, sweeps);
                rates.Add(bytesPerSweep * sweeps / took.TotalSeconds / 1e9);
            }
            while (Stopwatch.GetTimestamp() < deadline);

            rates.Sort();
            return ((long)elements * ElementBytes, rates);
        }
    }

    // Disposing the context executes the command list and waits on the fence, so the clock
    // covers every byte of the pass and nothing still in flight.
    private static TimeSpan Sweep(GraphicsDevice device, ReadOnlyBuffer<UInt4> source, ReadWriteBuffer<UInt4> destination, int sweeps)
    {
        int elements = source.Length;
        long started = Stopwatch.GetTimestamp();

        using (ComputeContext context = device.CreateComputeContext())
        {
            for (int sweep = 0; sweep < sweeps; sweep++)
            {
                for (int offset = 0; offset < elements; offset += Slice)
                {
                    context.For(Math.Min(Slice, elements - offset), new BandwidthKernel(source, destination, offset));
                }

                context.Barrier(destination);
            }
        }

        return Stopwatch.GetElapsedTime(started);
    }

    // Two 1 GiB buffers, or two of 512 MiB on an adapter that cannot hold the pair; the
    // size is reported either way, so a smaller buffer never passes as the full run.
    private static (ReadOnlyBuffer<UInt4> Source, ReadWriteBuffer<UInt4> Destination) AllocatePair(GraphicsDevice device)
    {
        try
        {
            return AllocatePair(device, PreferredBytes);
        }
        catch (Exception e) when (!DeviceLoss.Matches(e))
        {
            return AllocatePair(device, FallbackBytes);
        }
    }

    private static (ReadOnlyBuffer<UInt4> Source, ReadWriteBuffer<UInt4> Destination) AllocatePair(GraphicsDevice device, int bytes)
    {
        ReadOnlyBuffer<UInt4> source = device.AllocateReadOnlyBuffer<UInt4>(bytes / ElementBytes);

        try
        {
            return (source, device.AllocateReadWriteBuffer<UInt4>(bytes / ElementBytes));
        }
        catch
        {
            source.Dispose();
            throw;
        }
    }

    // Random bytes, so no compression or zero-page shortcut in the driver can make the copy
    // cheaper than a real workload's. One 16 MiB chunk repeated is as good as fresh data:
    // compression works on blocks far smaller than that.
    private static void Fill(ReadOnlyBuffer<UInt4> buffer)
    {
        UInt4[] chunk = new UInt4[Math.Min(FillElements, buffer.Length)];
        Random.Shared.NextBytes(MemoryMarshal.AsBytes(chunk.AsSpan()));

        for (int offset = 0; offset < buffer.Length; offset += chunk.Length)
        {
            buffer.CopyFrom(chunk.AsSpan(0, Math.Min(chunk.Length, buffer.Length - offset)), offset);
        }
    }

    // Multiples of 1/16 in [-1, 1): exact in half, so one CPU reference checks both storage formats.
    private static float[] Matrix(int n, uint seed)
    {
        float[] values = new float[n * n];
        uint state = seed;

        for (int i = 0; i < values.Length; i++)
        {
            state = state * 1664525u + 1013904223u;
            values[i] = ((int)(state >> 27) - 16) / 16f;
        }

        return values;
    }

    private static double Matmul(GraphicsDevice device, float[] a, float[] b, bool halfStorage)
    {
        int n = MatmulN;
        int rowBlocks = n / MatmulKernel.Block;

        // The kernel takes A column-major so both tiles land in shared memory as vectors.
        using ReadOnlyBuffer<UInt4> bufferA = Upload(device, Transpose(a, n), halfStorage);
        using ReadOnlyBuffer<UInt4> bufferB = Upload(device, b, halfStorage);
        using ReadWriteBuffer<Float4> c = device.AllocateReadWriteBuffer<Float4>(n * n / 4);

        // One row block twice: the first pays the DXIL compile, the second sizes the
        // dispatches (dependencies.md: by throughput, never a fixed count). A third pass, the
        // whole product once, sizes the timed run: on a fast card one product is a few
        // milliseconds, where the submit and fence round trip would cost several percent
        // and the clock has not settled, so the product is repeated under one fence until
        // the run is about 100 ms long. A slow card gets one product per run.
        Multiply(device, bufferA, bufferB, c, 1, 1, 1, halfStorage);
        TimeSpan block = Multiply(device, bufferA, bufferB, c, 1, 1, 1, halfStorage);
        int blocksPerDispatch = (int)Math.Clamp(DispatchTarget.Ticks / Math.Max(block.Ticks, 1), 1, rowBlocks);
        TimeSpan product = Multiply(device, bufferA, bufferB, c, rowBlocks, blocksPerDispatch, 1, halfStorage);
        int repeats = (int)Math.Clamp(RunTarget.Ticks / Math.Max(product.Ticks, 1), 1, MaxRepeats);

        double[] seconds = new double[MatmulRuns];

        for (int run = 0; run < MatmulRuns; run++)
        {
            seconds[run] = Multiply(device, bufferA, bufferB, c, rowBlocks, blocksPerDispatch, repeats, halfStorage).TotalSeconds;
        }

        Check(c, a, b, n);
        Array.Sort(seconds);

        return 2.0 * n * n * n * repeats / seconds[MatmulRuns / 2] / 1e12;
    }

    // Every repeat rewrites C with the same values; the barrier between them keeps that a
    // sequence rather than a race, at the cost of one drain per product.
    private static TimeSpan Multiply(GraphicsDevice device, ReadOnlyBuffer<UInt4> a, ReadOnlyBuffer<UInt4> b, ReadWriteBuffer<Float4> c, int rowBlocks, int blocksPerDispatch, int repeats, bool halfStorage)
    {
        int width = MatmulN / MatmulKernel.Block * MatmulKernel.Threads;
        long started = Stopwatch.GetTimestamp();

        using (ComputeContext context = device.CreateComputeContext())
        {
            for (int repeat = 0; repeat < repeats; repeat++)
            {
                for (int first = 0; first < rowBlocks; first += blocksPerDispatch)
                {
                    int count = Math.Min(blocksPerDispatch, rowBlocks - first);

                    context.For(width, count * MatmulKernel.Threads, new MatmulKernel(a, b, c, MatmulN, first, halfStorage));
                }

                context.Barrier(c);
            }
        }

        return Stopwatch.GetElapsedTime(started);
    }

    private static float[] Transpose(float[] values, int n)
    {
        float[] transposed = new float[values.Length];

        for (int row = 0; row < n; row++)
        {
            for (int col = 0; col < n; col++)
            {
                transposed[col * n + row] = values[row * n + col];
            }
        }

        return transposed;
    }

    private static ReadOnlyBuffer<UInt4> Upload(GraphicsDevice device, float[] values, bool halfStorage)
    {
        if (!halfStorage)
        {
            return device.AllocateReadOnlyBuffer(MemoryMarshal.Cast<float, UInt4>(values));
        }

        // Little-endian, so element 2i lands in the low half of uint i, as the kernel unpacks it.
        ushort[] packed = new ushort[values.Length];

        for (int i = 0; i < values.Length; i++)
        {
            packed[i] = BitConverter.HalfToUInt16Bits((Half)values[i]);
        }

        return device.AllocateReadOnlyBuffer(MemoryMarshal.Cast<ushort, UInt4>(packed));
    }

    // Four cells against a double-precision reference. Timing-only does not mean unchecked:
    // a mis-tiled kernel or an out-of-range read (D3D returns zeros) would still burn the
    // same FLOPS and report a plausible number.
    private static void Check(ReadWriteBuffer<Float4> c, float[] a, float[] b, int n)
    {
        Float4[] cell = new Float4[1];

        foreach ((int row, int col) in new[] { (0, 0), (n - 1, n - 1), (n / 2, 5), (3, n / 2) })
        {
            double expected = 0;

            for (int k = 0; k < n; k++)
            {
                expected += (double)a[row * n + k] * b[k * n + col];
            }

            c.CopyTo(cell.AsSpan(), row * (n / 4) + col / 4);
            float actual = MemoryMarshal.Cast<Float4, float>(cell)[col % 4];

            if (Math.Abs(actual - expected) > 1e-3 * (1 + Math.Abs(expected)))
            {
                throw new InvalidOperationException($"matmul self-check failed at ({row}, {col}): gpu {actual} cpu {expected}");
            }
        }
    }
}
