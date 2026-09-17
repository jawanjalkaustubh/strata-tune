using StrataTune.Shared;

namespace StrataTune.Collector;

/// <summary>The numbers of plan section 16 with no I/O in them, so the TypeScript side can
/// mirror and test the same table: step sizes, the bisect, the stage-2 regression rule,
/// the verdict per pattern and per candidate, and the confidence rating. Everything is in
/// NVAPI's kHz.</summary>
internal static class TuneLadder
{
    public const int CoreStepKhz = 30_000, CoreResolutionKhz = 15_000;
    public const int MemStepKhz = 100_000, MemResolutionKhz = 25_000;
    // Stage 2: GDDR7 corrects silently and just gets slower, so bandwidth this far under
    // the best seen at a lower step is the memory failing, not noise. The worker alone
    // repeats within half a percent; under the collector's 2 Hz sampling it spread 9 % on
    // the dev box (plan risk R4), so the floor is also measured: three times the spread of
    // the baseline step's own passes, whichever is larger.
    public const double BandwidthRegression = 0.03;
    public const double NoiseFloorMultiple = 3;
    // A throttle bit on more than this share of the heavy pattern's samples makes the
    // candidate invalid: the card was held back by power or heat, not tested.
    public const double ThrottledFractionLimit = 0.05;
    // SwPowerCap, HwSlowdown, SwThermalSlowdown, HwThermalSlowdown, HwPowerBrakeSlowdown
    // (dependencies.md); 0x400 and GpuIdle are load indicators, not limits.
    public const ulong ThrottleBits = 0x4 | 0x8 | 0x20 | 0x40 | 0x80;
    // The memory sweep stops climbing only after this many steps in a row fail to raise
    // the bandwidth: one flat step is within the noise, two is the memory retrying.
    public const int SweepFlatSteps = 2;

    public static readonly (TunePattern Pattern, int Seconds)[] HuntPatterns =
        [(TunePattern.Heavy, 20), (TunePattern.Light, 10), (TunePattern.Transient, 10)];

    /// <summary>The memory sweep measures bandwidth per step under the heavy pattern, whose
    /// hash passes are the stage-1 check for the step and whose closing stream pass is the
    /// number; three passes so the step's figure is a median, not one sample.</summary>
    public static readonly (TunePattern Pattern, int Seconds)[] SweepPatterns =
        [(TunePattern.Heavy, 5), (TunePattern.Heavy, 5), (TunePattern.Heavy, 5)];

    /// <summary>Five minutes sustained at the user's own fan curve (we do not control fans)
    /// plus two minutes of switching, the pattern an undervolt fails on the desktop.</summary>
    public static readonly (TunePattern Pattern, int Seconds)[] ValidatePatterns =
        [(TunePattern.Heavy, 300), (TunePattern.Transient, 120)];

    /// <summary>The next coarse rung above the current one, or null at the driver's ceiling.</summary>
    public static int? NextCoarse(int currentKhz, int stepKhz, int maxKhz) =>
        currentKhz + stepKhz <= maxKhz ? currentKhz + stepKhz : null;

    /// <summary>The rung to test between the last stable and the first failing value, on a
    /// whole MHz, or null once the gap is at the resolution: the last stable value is the result.</summary>
    public static int? Midpoint(int stableKhz, int failingKhz, int resolutionKhz)
    {
        var gap = failingKhz - stableKhz;
        return gap > resolutionKhz ? stableKhz + gap / 2 / 1000 * 1000 : null;
    }

    /// <summary>The share of the best a step may fall below before it is a regression: the
    /// fixed 3 %, or three times the noise the baseline step showed, whichever is more.</summary>
    public static double RegressionFloor(double? baselineSpread) =>
        Math.Max(BandwidthRegression, NoiseFloorMultiple * (baselineSpread ?? 0));

    public static bool Regressed(double bandwidthGBs, double? bestGBs, double? baselineSpread = null) =>
        bestGBs is { } best && best > 0 && bandwidthGBs < best * (1 - RegressionFloor(baselineSpread));

    public static double Median(IReadOnlyList<double> values)
    {
        var sorted = values.Order().ToArray();
        return sorted.Length % 2 == 1 ? sorted[sorted.Length / 2] : (sorted[sorted.Length / 2 - 1] + sorted[sorted.Length / 2]) / 2;
    }

    /// <summary>(max - min) / median: the relative spread of a step's passes.</summary>
    public static double Spread(IReadOnlyList<double> values)
    {
        if (values.Count < 2)
            return 0;
        var median = Median(values);
        return median > 0 ? (values.Max() - values.Min()) / median : 0;
    }

    /// <summary>One pattern's verdict from what the worker said: a device loss (stage 3,
    /// exit 10 or a dead heartbeat), a hash mismatch (stage 1, exit 2), or a pass that the
    /// candidate's judgement takes further. Null for an exit that is not a verdict at all
    /// (bad arguments, no hardware GPU): the run fails rather than counting a broken worker
    /// as an unstable card.</summary>
    public static (TuneVerdict Verdict, int? Stage)? PatternVerdict(int exitCode, bool heartbeatStale)
    {
        if (heartbeatStale || exitCode == 10)
            return (TuneVerdict.DeviceLost, 3);
        if (exitCode == 2)
            return (TuneVerdict.Unstable, 1);
        return exitCode == 0 ? (TuneVerdict.Stable, null) : null;
    }

    /// <summary>The candidate's verdict once every pattern passed: a throttled heavy pattern
    /// is invalid before anything else is asked of it (a power-capped step is slower, and
    /// that is the cap, not the memory failing); then the bandwidth against the best is
    /// stage 2; then stable.</summary>
    public static (TuneVerdict Verdict, int? Stage) Judge(double throttledFraction, bool throttleGate, double? bandwidthGBs, double? bestGBs, double? baselineSpread)
    {
        if (throttleGate && throttledFraction > ThrottledFractionLimit)
            return (TuneVerdict.Invalid, null);
        if (bandwidthGBs is { } bw && Regressed(bw, bestGBs, baselineSpread))
            return (TuneVerdict.Unstable, 2);
        return (TuneVerdict.Stable, null);
    }

    /// <summary>High: the ceiling was found and bisected with nothing in the way. Medium: it
    /// was found, but a device loss or an invalid (throttled) rung sits in the record, or
    /// the ladder ran into the driver's limit before finding it. Low: the run did not get
    /// there, or found nothing above the baseline.</summary>
    public static TuneConfidence Confidence(bool converged, bool atDriverMax, int deviceLostCount, bool anyInvalid, bool aboveBaseline)
    {
        if (!converged || !aboveBaseline)
            return TuneConfidence.Low;
        return deviceLostCount > 0 || anyInvalid || atDriverMax ? TuneConfidence.Medium : TuneConfidence.High;
    }
}
