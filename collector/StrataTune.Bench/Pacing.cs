using System.Diagnostics;
using System.Runtime.InteropServices;

namespace StrataTune.Bench;

/// <summary>Frame pacing and the deliberate CPU stall. Sleeps are only as fine as the system
/// timer, so the process asks for 1 ms like a game does and spins the last two milliseconds.</summary>
internal static partial class Pacing
{
    private const int SleepMarginMs = 2;
    private static ulong spinSink;

    public static void SleepUntil(long deadline)
    {
        long remainingMs = (deadline - Stopwatch.GetTimestamp()) * 1000 / Stopwatch.Frequency;
        if (remainingMs > SleepMarginMs)
        {
            Thread.Sleep((int)remainingMs - SleepMarginMs);
        }

        while (Stopwatch.GetTimestamp() < deadline)
        {
            Thread.SpinWait(64);
        }
    }

    /// <summary>Burns this thread for <paramref name="ms"/>: real arithmetic, so it reads as CPU busy time, not as a wait.</summary>
    public static void Spin(double ms)
    {
        long deadline = Stopwatch.GetTimestamp() + (long)(ms / 1000 * Stopwatch.Frequency);
        ulong x = spinSink | 1;
        while (Stopwatch.GetTimestamp() < deadline)
        {
            for (int i = 0; i < 4096; i++)
            {
                x = x * 6364136223846793005UL + 1442695040888963407UL;
            }
        }
        spinSink = x;
    }

    /// <summary>1 ms timer resolution for the life of the run.</summary>
    public sealed class TimerResolution : IDisposable
    {
        private const uint Period = 1;

        public TimerResolution() => timeBeginPeriod(Period);

        public void Dispose() => timeEndPeriod(Period);
    }

    [LibraryImport("winmm.dll")]
    private static partial uint timeBeginPeriod(uint period);

    [LibraryImport("winmm.dll")]
    private static partial uint timeEndPeriod(uint period);
}
