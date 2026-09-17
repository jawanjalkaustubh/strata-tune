using System.Diagnostics;
using ComputeSharp;

namespace StrataTune.Worker;

internal enum Pattern { Variable, Sustained }

/// <summary>What a pattern did: load dispatches issued (the verified passes not counted),
/// the lane steps they computed, and the wall time spent inside them. Steps per busy
/// millisecond is the throughput the supervisor compares between core rungs (plan section
/// 16: a rung under a power cap is judged by work, not clock); it is only meaningful for
/// the sustained pattern, whose dispatches run back to back.</summary>
internal readonly record struct PatternStats(int Dispatches, long Steps, double BusyMs);

/// <summary>
/// The two halves of one ladder rung (plan section 16, 'a rung is a minute of realistic
/// load'; user 2026-09-16: "variable in the first 30 s with spikes every 2–4 s, and another
/// 30 s full load"). A candidate that survives an hour of heavy load and crashes on the
/// desktop is the common failure: the clock and voltage transitions at the start and end of
/// each burst, and the low-voltage points the card sits at between them, are the fragile
/// ones, so <c>variable</c> is not a weaker <c>sustained</c> but a different test. Every
/// dispatch stays under the ~40 ms the loads size themselves to, so a TDR here is real
/// instability and never the workload. <c>check</c> is the verified pass; it returns false
/// to end the run early.
/// </summary>
internal static class Patterns
{
    // Bursts start 2–4 s apart and last 0.5–1.5 s; the gap between them is light dispatches
    // (one per 50 ms, the clock bouncing at the bottom of the curve) or nothing at all (the
    // next burst then starts from an idle card, the transient the old pattern set tested).
    private const int BurstGapMinMs = 2000, BurstGapMaxMs = 4000;
    private const int BurstMinMs = 500, BurstMaxMs = 1500;
    // Seeded, and the seed is fixed: every rung, every run and every card gets the same
    // sequence of burst lengths, gaps and gap kinds, so rung scores and comparison sheets
    // compare like for like. The word is "STRA".
    private const uint ShapeSeed = 0x53545241;
    private static readonly TimeSpan IdleSlice = TimeSpan.FromMilliseconds(50);

    public static Pattern Parse(string text) => text switch
    {
        "variable" => Pattern.Variable,
        "sustained" => Pattern.Sustained,
        _ => throw new ArgumentException($"--pattern: {text} is not variable or sustained"),
    };

    public static string Name(Pattern pattern) => pattern == Pattern.Variable ? "variable" : "sustained";

    public static PatternStats Run(GraphicsDevice device, Pattern pattern, long deadline, Func<bool> check) =>
        pattern == Pattern.Sustained ? Sustained(device, deadline, check) : Variable(device, deadline, check);

    // Continuous dispatches, each followed by a pass: --load heavy with the detector after
    // every step. The dispatch is timed on its own, so the pass and its CPU fold are not in
    // the throughput figure.
    private static PatternStats Sustained(GraphicsDevice device, long deadline, Func<bool> check)
    {
        using HeavyLoad load = new(device);
        long busy = 0;

        while (Stopwatch.GetTimestamp() < deadline)
        {
            long started = Stopwatch.GetTimestamp();
            load.Dispatch();
            busy += Stopwatch.GetTimestamp() - started;

            if (!check())
            {
                break;
            }
        }

        return Stats(load, busy);
    }

    // Bursts of heavy dispatches with a pass after each (the hash is checked on every
    // burst, and inside it), then a gap of light dispatches or idle with a pass at its end,
    // read off a card that has just dropped to its lowest point. The first dispatch of the
    // next burst runs while the clocks and the voltage are still climbing.
    private static PatternStats Variable(GraphicsDevice device, long deadline, Func<bool> check)
    {
        using HeavyLoad heavy = new(device);
        using LightLoad light = new(device);
        Shape shape = new(ShapeSeed);
        long busy = 0;

        while (Stopwatch.GetTimestamp() < deadline)
        {
            long burstStart = Stopwatch.GetTimestamp();
            TimeSpan burst = shape.Next(BurstMinMs, BurstMaxMs);
            TimeSpan period = shape.Next(BurstGapMinMs, BurstGapMaxMs);
            bool lightGap = shape.Coin();

            while (Stopwatch.GetTimestamp() < deadline && Stopwatch.GetElapsedTime(burstStart) < burst)
            {
                long started = Stopwatch.GetTimestamp();
                heavy.Dispatch();
                busy += Stopwatch.GetTimestamp() - started;

                if (!check())
                {
                    return Stats(heavy, busy);
                }
            }

            long gapEnd = Math.Min(deadline, burstStart + (long)(period.TotalSeconds * Stopwatch.Frequency));
            while (Stopwatch.GetTimestamp() < gapEnd)
            {
                if (lightGap)
                {
                    // The pause is inside the light dispatch: one small kernel per 50 ms.
                    light.Dispatch();
                }
                else
                {
                    Thread.Sleep(Min(IdleSlice, Remaining(gapEnd)));
                }
            }

            if (!check())
            {
                break;
            }
        }

        return Stats(heavy, busy);
    }

    private static PatternStats Stats(GpuLoad load, long busyTicks) =>
        new(load.Dispatches, load.Steps, busyTicks * 1000.0 / Stopwatch.Frequency);

    private static TimeSpan Remaining(long deadline) => TimeSpan.FromSeconds(Math.Max(0, deadline - Stopwatch.GetTimestamp()) / (double)Stopwatch.Frequency);

    private static TimeSpan Min(TimeSpan a, TimeSpan b) => a < b ? a : b;

    /// <summary>xorshift32 from a fixed seed: the burst shape, the same every time.</summary>
    private sealed class Shape(uint seed)
    {
        private uint _state = seed;

        private uint Next()
        {
            _state ^= _state << 13;
            _state ^= _state >> 17;
            _state ^= _state << 5;
            return _state;
        }

        public TimeSpan Next(int minMs, int maxMs) => TimeSpan.FromMilliseconds(minMs + Next() % (uint)(maxMs - minMs + 1));

        public bool Coin() => (Next() & 1) == 1;
    }
}
