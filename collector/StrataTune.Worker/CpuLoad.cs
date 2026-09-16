using System.Diagnostics;
using System.Runtime.Intrinsics;
using System.Runtime.Intrinsics.X86;

namespace StrataTune.Worker;

internal readonly record struct CpuLoadResult(int Threads, TimeSpan Elapsed, long Steps, uint Mix);

/// <summary>
/// Timed all-core CPU load for the audit's CPU rules (phase1-polish item 6), run on one
/// thread per logical CPU with no memory traffic, so what heats up is the cores and what
/// the sensors show is the boost governor's answer to a full load. The kernel is the
/// logistic map x = r·x·(1 − x) over eight independent float vectors per thread: chaotic,
/// so the bits keep toggling; bounded in (0, 1), so no infinities or denormals; and eight
/// chains keep both FMA pipes full. A scalar integer chain drew 138 W on the 230 W dev box
/// and told the power and thermal rules nothing; the vector FMA units are what a real
/// all-core load leans on, and they pull the package to its limit. The threads run below
/// normal priority so the collector sampling beside them keeps its 2 Hz; on an otherwise
/// idle box they still own every core. The GPU is never touched.
/// </summary>
internal static class CpuLoad
{
    private const float R = 3.99f;
    private const int Chains = 8;
    // Iterations between deadline checks: about a millisecond of work, so the run ends on time.
    private const int Batch = 1 << 16;

    public static CpuLoadResult Run(int seconds, int threads)
    {
        long started = Stopwatch.GetTimestamp();
        long deadline = started + seconds * Stopwatch.Frequency;
        long[] steps = new long[threads];
        uint[] mixes = new uint[threads];

        Thread[] workers = new Thread[threads];
        for (int t = 0; t < threads; t++)
        {
            int lane = t;
            workers[t] = new Thread(() => (steps[lane], mixes[lane]) = Spin(lane, deadline))
            {
                IsBackground = true,
                Priority = ThreadPriority.BelowNormal,
                Name = $"cpu-load-{lane}",
            };
            workers[t].Start();
        }

        foreach (Thread worker in workers)
        {
            worker.Join();
        }

        uint mix = 0;
        foreach (uint m in mixes)
        {
            mix ^= m;
        }

        return new CpuLoadResult(threads, Stopwatch.GetElapsedTime(started), steps.Sum(), mix);
    }

    // Widest FMA the box has, so the load is the one a renderer or an encoder would put on it.
    private static (long Steps, uint Mix) Spin(int lane, long deadline)
    {
        if (Vector512.IsHardwareAccelerated && Avx512F.IsSupported) return Spin512(lane, deadline);
        if (Vector256.IsHardwareAccelerated && Fma.IsSupported) return Spin256(lane, deadline);
        return SpinScalar(lane, deadline);
    }

    // Distinct seeds per lane and chain, all strictly inside (0, 1).
    private static float Seed(int lane, int chain, int element) =>
        0.1f + 0.8f * (((lane * 31 + chain * 7 + element) * 0.6180339887f) % 1f);

    private static (long Steps, uint Mix) Spin512(int lane, long deadline)
    {
        var x = new Vector512<float>[Chains];
        for (int c = 0; c < Chains; c++)
        {
            x[c] = Vector512.Create(Seed(lane, c, 0), Seed(lane, c, 1), Seed(lane, c, 2), Seed(lane, c, 3),
                Seed(lane, c, 4), Seed(lane, c, 5), Seed(lane, c, 6), Seed(lane, c, 7),
                Seed(lane, c, 8), Seed(lane, c, 9), Seed(lane, c, 10), Seed(lane, c, 11),
                Seed(lane, c, 12), Seed(lane, c, 13), Seed(lane, c, 14), Seed(lane, c, 15));
        }

        var r = Vector512.Create(R);
        Vector512<float> x0 = x[0], x1 = x[1], x2 = x[2], x3 = x[3], x4 = x[4], x5 = x[5], x6 = x[6], x7 = x[7];
        long steps = 0;
        while (Stopwatch.GetTimestamp() < deadline)
        {
            for (int i = 0; i < Batch; i++)
            {
                // u = r·x, then x = u − u·x: one multiply and one fused multiply-add per chain.
                Vector512<float> u0 = r * x0, u1 = r * x1, u2 = r * x2, u3 = r * x3;
                Vector512<float> u4 = r * x4, u5 = r * x5, u6 = r * x6, u7 = r * x7;
                x0 = Avx512F.FusedMultiplyAddNegated(u0, x0, u0);
                x1 = Avx512F.FusedMultiplyAddNegated(u1, x1, u1);
                x2 = Avx512F.FusedMultiplyAddNegated(u2, x2, u2);
                x3 = Avx512F.FusedMultiplyAddNegated(u3, x3, u3);
                x4 = Avx512F.FusedMultiplyAddNegated(u4, x4, u4);
                x5 = Avx512F.FusedMultiplyAddNegated(u5, x5, u5);
                x6 = Avx512F.FusedMultiplyAddNegated(u6, x6, u6);
                x7 = Avx512F.FusedMultiplyAddNegated(u7, x7, u7);
            }

            steps += (long)Batch * Chains * Vector512<float>.Count;
        }

        var sum = x0 + x1 + x2 + x3 + x4 + x5 + x6 + x7;
        return (steps, Sink(Vector512.Sum(sum)));
    }

    private static (long Steps, uint Mix) Spin256(int lane, long deadline)
    {
        var x = new Vector256<float>[Chains];
        for (int c = 0; c < Chains; c++)
        {
            x[c] = Vector256.Create(Seed(lane, c, 0), Seed(lane, c, 1), Seed(lane, c, 2), Seed(lane, c, 3),
                Seed(lane, c, 4), Seed(lane, c, 5), Seed(lane, c, 6), Seed(lane, c, 7));
        }

        var r = Vector256.Create(R);
        Vector256<float> x0 = x[0], x1 = x[1], x2 = x[2], x3 = x[3], x4 = x[4], x5 = x[5], x6 = x[6], x7 = x[7];
        long steps = 0;
        while (Stopwatch.GetTimestamp() < deadline)
        {
            for (int i = 0; i < Batch; i++)
            {
                Vector256<float> u0 = r * x0, u1 = r * x1, u2 = r * x2, u3 = r * x3;
                Vector256<float> u4 = r * x4, u5 = r * x5, u6 = r * x6, u7 = r * x7;
                x0 = Fma.MultiplyAddNegated(u0, x0, u0);
                x1 = Fma.MultiplyAddNegated(u1, x1, u1);
                x2 = Fma.MultiplyAddNegated(u2, x2, u2);
                x3 = Fma.MultiplyAddNegated(u3, x3, u3);
                x4 = Fma.MultiplyAddNegated(u4, x4, u4);
                x5 = Fma.MultiplyAddNegated(u5, x5, u5);
                x6 = Fma.MultiplyAddNegated(u6, x6, u6);
                x7 = Fma.MultiplyAddNegated(u7, x7, u7);
            }

            steps += (long)Batch * Chains * Vector256<float>.Count;
        }

        var sum = x0 + x1 + x2 + x3 + x4 + x5 + x6 + x7;
        return (steps, Sink(Vector256.Sum(sum)));
    }

    private static (long Steps, uint Mix) SpinScalar(int lane, long deadline)
    {
        float x0 = Seed(lane, 0, 0), x1 = Seed(lane, 1, 0), x2 = Seed(lane, 2, 0), x3 = Seed(lane, 3, 0);
        float x4 = Seed(lane, 4, 0), x5 = Seed(lane, 5, 0), x6 = Seed(lane, 6, 0), x7 = Seed(lane, 7, 0);
        long steps = 0;
        while (Stopwatch.GetTimestamp() < deadline)
        {
            for (int i = 0; i < Batch; i++)
            {
                x0 = R * x0 * (1f - x0); x1 = R * x1 * (1f - x1); x2 = R * x2 * (1f - x2); x3 = R * x3 * (1f - x3);
                x4 = R * x4 * (1f - x4); x5 = R * x5 * (1f - x5); x6 = R * x6 * (1f - x6); x7 = R * x7 * (1f - x7);
            }

            steps += (long)Batch * Chains;
        }

        return (steps, Sink(x0 + x1 + x2 + x3 + x4 + x5 + x6 + x7));
    }

    // The final state is returned, so the JIT cannot drop the loops.
    private static uint Sink(float v) => BitConverter.SingleToUInt32Bits(v);
}
