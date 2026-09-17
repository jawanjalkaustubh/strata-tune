using System.Diagnostics;
using ComputeSharp;

namespace StrataTune.Worker;

internal enum Pattern { Heavy, Light, Transient }

/// <summary>
/// The three load shapes of one ladder rung (plan section 16). A candidate that survives an
/// hour of heavy load and crashes on the desktop is the common failure: the low-voltage
/// points of the VF curve are the fragile ones, so "light" and "transient" are not weaker
/// versions of "heavy" but different tests. Every dispatch stays under the ~40 ms the loads
/// size themselves to, so a TDR here is real instability and never the workload.
/// <c>check</c> is the verified pass; it returns false to end the run early.
/// </summary>
internal static class Patterns
{
    // Light: a pass every second. Transient: 500 ms of heavy load, 500 ms of nothing.
    private static readonly TimeSpan CheckPeriod = TimeSpan.FromSeconds(1);
    private static readonly TimeSpan Phase = TimeSpan.FromMilliseconds(500);

    public static Pattern Parse(string text) => text switch
    {
        "heavy" => Pattern.Heavy,
        "light" => Pattern.Light,
        "transient" => Pattern.Transient,
        _ => throw new ArgumentException($"--pattern: {text} is not heavy, light or transient"),
    };

    public static string Name(Pattern pattern) => pattern switch
    {
        Pattern.Heavy => "heavy",
        Pattern.Light => "light",
        _ => "transient",
    };

    /// <returns>Load dispatches issued, the verified passes not counted.</returns>
    public static int Run(GraphicsDevice device, Pattern pattern, long deadline, Func<bool> check) => pattern switch
    {
        Pattern.Heavy => Heavy(device, deadline, check),
        Pattern.Light => Light(device, deadline, check),
        _ => Transient(device, deadline, check),
    };

    // Continuous dispatches, each followed by a pass: --load heavy with the detector after every step.
    private static int Heavy(GraphicsDevice device, long deadline, Func<bool> check)
    {
        using HeavyLoad load = new(device);

        while (Stopwatch.GetTimestamp() < deadline)
        {
            load.Dispatch();

            if (!check())
            {
                break;
            }
        }

        return load.Dispatches;
    }

    // One small dispatch every ~50 ms with a pass once a second, and one more at the end so
    // the run ends on a verification: the clocks sit at the bottom of the curve in between.
    private static int Light(GraphicsDevice device, long deadline, Func<bool> check)
    {
        using LightLoad load = new(device);
        long lastCheck = Stopwatch.GetTimestamp();

        while (Stopwatch.GetTimestamp() < deadline)
        {
            load.Dispatch();

            if (Stopwatch.GetElapsedTime(lastCheck) >= CheckPeriod)
            {
                if (!check())
                {
                    return load.Dispatches;
                }

                lastCheck = Stopwatch.GetTimestamp();
            }
        }

        check();
        return load.Dispatches;
    }

    // Heavy and idle in turn, a pass at each transition: the first dispatch after an idle
    // phase runs while the clocks and the voltage are still climbing, and the pass after the
    // idle phase is read off a card that has just dropped to its lowest point.
    private static int Transient(GraphicsDevice device, long deadline, Func<bool> check)
    {
        using HeavyLoad load = new(device);

        while (Stopwatch.GetTimestamp() < deadline)
        {
            long burst = Stopwatch.GetTimestamp();

            while (Stopwatch.GetTimestamp() < deadline && Stopwatch.GetElapsedTime(burst) < Phase)
            {
                load.Dispatch();
            }

            if (!check())
            {
                break;
            }

            TimeSpan idle = Min(Phase, Remaining(deadline));
            if (idle > TimeSpan.Zero)
            {
                Thread.Sleep(idle);
            }

            if (!check())
            {
                break;
            }
        }

        return load.Dispatches;
    }

    private static TimeSpan Remaining(long deadline) => TimeSpan.FromSeconds((deadline - Stopwatch.GetTimestamp()) / (double)Stopwatch.Frequency);

    private static TimeSpan Min(TimeSpan a, TimeSpan b) => a < b ? a : b;
}
