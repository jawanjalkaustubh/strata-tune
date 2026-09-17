using System.Diagnostics;
using ComputeSharp;

namespace StrataTune.Worker;

internal readonly record struct LoadResult(int Dispatches, TimeSpan Elapsed, long Steps);

/// <summary>
/// Timed GPU load for the audit's thermal-headroom and PCIe checks (plan section 8): the
/// hash kernel run for its heat rather than its result. "light" is one small dispatch every
/// 50 ms, a few percent of a discrete card; "heavy" is back-to-back dispatches with no sleep,
/// each sized from the one before it so it stays well under the 2 s TDR budget on any
/// adapter. Timing-only: nothing here is hash-verified. The ladder's patterns (section 16)
/// run the same two loads one dispatch at a time with a verified pass between them.
/// </summary>
internal static class Load
{
    public static LoadResult Run(GraphicsDevice device, string kind, int seconds)
    {
        long started = Stopwatch.GetTimestamp();
        long deadline = started + seconds * Stopwatch.Frequency;
        using GpuLoad load = kind == "light" ? new LightLoad(device) : new HeavyLoad(device);

        while (Stopwatch.GetTimestamp() < deadline)
        {
            load.Dispatch();
        }

        return new LoadResult(load.Dispatches, Stopwatch.GetElapsedTime(started), load.Steps);
    }
}

/// <summary>One dispatch of the hash kernel at a time over a buffer kept for the run, so a
/// caller can put its own work (a verified pass, a pause) between dispatches.</summary>
internal abstract class GpuLoad : IDisposable
{
    protected const uint Seed = 0x53545241;

    protected readonly GraphicsDevice device;
    protected readonly ReadWriteBuffer<uint> slots;
    protected uint round;

    public int Dispatches { get; protected set; }
    public long Steps { get; protected set; }

    protected GpuLoad(GraphicsDevice device, int elements)
    {
        this.device = device;
        slots = device.AllocateReadWriteBuffer<uint>(elements, AllocationMode.Clear);
    }

    public abstract void Dispatch();

    public void Dispose() => slots.Dispose();
}

/// <summary>The pause is part of the dispatch: a light load is defined by its duty cycle.</summary>
internal sealed class LightLoad : GpuLoad
{
    private const int Elements = 1 << 16;
    private const uint Rounds = 4;
    private static readonly TimeSpan Period = TimeSpan.FromMilliseconds(50);

    public LightLoad(GraphicsDevice device) : base(device, Elements)
    {
    }

    public override void Dispatch()
    {
        long started = Stopwatch.GetTimestamp();
        device.For(Elements, new HashKernel(slots, 0, Seed, round, Rounds));
        round += Rounds;
        Dispatches++;
        Steps += Elements * Rounds;

        TimeSpan remaining = Period - Stopwatch.GetElapsedTime(started);
        if (remaining > TimeSpan.Zero)
        {
            Thread.Sleep(remaining);
        }
    }
}

internal sealed class HeavyLoad : GpuLoad
{
    // One full-width dispatch (65535 groups x 64 threads), the same slice HashRun uses; 16
    // rounds of it is 2^26 steps, about 10 ms on WARP and far below the TDR budget, which is
    // why it is a safe first measurement on an unknown adapter.
    private const int Elements = 65535 * 64;
    private const int WarmupRounds = 16;
    private const int MaxRounds = 1 << 20;
    private const int MaxGrowth = 4;
    private static readonly TimeSpan Target = TimeSpan.FromMilliseconds(40);
    private static readonly TimeSpan Ceiling = TimeSpan.FromMilliseconds(120);

    private int rounds = WarmupRounds;

    public HeavyLoad(GraphicsDevice device) : base(device, Elements)
    {
        // The first dispatch of a process pays for the driver's DXIL compile; a zero-round
        // pass takes that hit before anything is measured.
        device.For(Elements, new HashKernel(slots, 0, Seed, 0, 0));
    }

    public override void Dispatch()
    {
        long started = Stopwatch.GetTimestamp();
        device.For(Elements, new HashKernel(slots, 0, Seed, round, (uint)rounds));
        TimeSpan took = Stopwatch.GetElapsedTime(started);
        round += (uint)rounds;
        Dispatches++;
        Steps += (long)Elements * rounds;

        // Sized by measurement, not by a fixed count: the rounds that take 40 ms here
        // could take seconds on a weak card, and the clocks under load are a moving
        // target. Growth is capped so a noisy first reading cannot jump straight to a
        // dispatch that blows the budget.
        if (took > Ceiling)
        {
            rounds = Math.Max(1, rounds / 2);
        }
        else if (took < Target)
        {
            double scale = Math.Min(MaxGrowth, Target.Ticks / (double)Math.Max(took.Ticks, 1));
            rounds = (int)Math.Clamp(rounds * scale, rounds + 1, MaxRounds);
        }
    }
}
