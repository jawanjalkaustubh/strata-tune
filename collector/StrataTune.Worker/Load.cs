using System.Diagnostics;
using ComputeSharp;

namespace StrataTune.Worker;

internal readonly record struct LoadResult(int Dispatches, TimeSpan Elapsed, long Steps);

/// <summary>
/// Timed GPU load for the audit's thermal-headroom and PCIe checks (plan section 8): the
/// hash kernel run for its heat rather than its result. "light" is one small dispatch every
/// 50 ms, a few percent of a discrete card; "heavy" is back-to-back dispatches with no sleep,
/// each sized from the one before it so it stays well under the 2 s TDR budget on any
/// adapter. Timing-only: nothing here is hash-verified.
/// </summary>
internal static class Load
{
    private const uint Seed = 0x53545241;

    private const int LightElements = 1 << 16;
    private const uint LightRounds = 4;
    private static readonly TimeSpan LightPeriod = TimeSpan.FromMilliseconds(50);

    // One full-width dispatch (65535 groups x 64 threads), the same slice HashRun uses; 16
    // rounds of it is 2^26 steps, about 10 ms on WARP and far below the TDR budget, which is
    // why it is a safe first measurement on an unknown adapter.
    private const int HeavyElements = 65535 * 64;
    private const int WarmupRounds = 16;
    private const int MaxRounds = 1 << 20;
    private const int MaxGrowth = 4;
    private static readonly TimeSpan HeavyTarget = TimeSpan.FromMilliseconds(40);
    private static readonly TimeSpan HeavyCeiling = TimeSpan.FromMilliseconds(120);

    public static LoadResult Run(GraphicsDevice device, string kind, int seconds)
    {
        long started = Stopwatch.GetTimestamp();
        long deadline = started + seconds * Stopwatch.Frequency;
        (int dispatches, long steps) = kind == "light" ? Light(device, deadline) : Heavy(device, deadline);

        return new LoadResult(dispatches, Stopwatch.GetElapsedTime(started), steps);
    }

    private static (int Dispatches, long Steps) Light(GraphicsDevice device, long deadline)
    {
        using ReadWriteBuffer<uint> slots = device.AllocateReadWriteBuffer<uint>(LightElements, AllocationMode.Clear);
        int dispatches = 0;
        uint round = 0;

        while (Stopwatch.GetTimestamp() < deadline)
        {
            long started = Stopwatch.GetTimestamp();
            device.For(LightElements, new HashKernel(slots, 0, Seed, round, LightRounds));
            round += LightRounds;
            dispatches++;

            TimeSpan remaining = LightPeriod - Stopwatch.GetElapsedTime(started);
            if (remaining > TimeSpan.Zero)
            {
                Thread.Sleep(remaining);
            }
        }

        return (dispatches, (long)dispatches * LightElements * LightRounds);
    }

    private static (int Dispatches, long Steps) Heavy(GraphicsDevice device, long deadline)
    {
        using ReadWriteBuffer<uint> slots = device.AllocateReadWriteBuffer<uint>(HeavyElements, AllocationMode.Clear);

        // The first dispatch of a process pays for the driver's DXIL compile; a zero-round
        // pass takes that hit before anything is measured.
        device.For(HeavyElements, new HashKernel(slots, 0, Seed, 0, 0));

        int rounds = WarmupRounds;
        int dispatches = 0;
        long steps = 0;
        uint round = 0;

        while (Stopwatch.GetTimestamp() < deadline)
        {
            long started = Stopwatch.GetTimestamp();
            device.For(HeavyElements, new HashKernel(slots, 0, Seed, round, (uint)rounds));
            TimeSpan took = Stopwatch.GetElapsedTime(started);
            round += (uint)rounds;
            dispatches++;
            steps += (long)HeavyElements * rounds;

            // Sized by measurement, not by a fixed count: the rounds that take 40 ms here
            // could take seconds on a weak card, and the clocks under load are a moving
            // target. Growth is capped so a noisy first reading cannot jump straight to a
            // dispatch that blows the budget.
            if (took > HeavyCeiling)
            {
                rounds = Math.Max(1, rounds / 2);
            }
            else if (took < HeavyTarget)
            {
                double scale = Math.Min(MaxGrowth, HeavyTarget.Ticks / (double)Math.Max(took.Ticks, 1));
                rounds = (int)Math.Clamp(rounds * scale, rounds + 1, MaxRounds);
            }
        }

        return (dispatches, steps);
    }
}
