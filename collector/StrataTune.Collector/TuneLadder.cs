using StrataTune.Shared;

namespace StrataTune.Collector;

/// <summary>The numbers of plan section 16 with no I/O in them, so the TypeScript side can
/// mirror and test the same table: the rung shape and sizes, the bisect, the vendor-tune
/// decision before the first write, the additivity and movement checks on the held clock,
/// the stage-2 regression rules, the verdict per pattern and per rung, the official run's
/// step-down, and the confidence rating. Offsets are in NVAPI's kHz, clocks in NVML's MHz.</summary>
internal static class TuneLadder
{
    // The user's rule (2026-09-16): steps of 5–15 MHz on top of whatever the card holds.
    // A memory rung is 15 MHz NVML, 30 on the effective rate the vendor sliders show.
    public const int CoreStepKhz = 15_000, CoreResolutionKhz = 5_000;
    public const int MemStepKhz = 15_000, MemResolutionKhz = 5_000;
    // The climb must lift the held clock by at least this share of the offset written, or the
    // driver is not adding our offset on top of the card's tune and the ladder would climb
    // blind. The top of the curve moves in half bins between minutes (3322 / 3330 / 3337 on
    // the dev box, runs 154463d9b2f1 and bb09b0a0455c), so one +15 rung can read +7 whether
    // or not it was added: 0.6 x 15 = 9 is undecided there, and the +30 rung decides (an
    // offset that was added reads at least +22, one that was not at most +7).
    public const double AdditivityShare = 0.6;
    // NVML reports the SM clock on 15 MHz boost bins (3000, 3015, 3225 on the dev box), so a
    // held clock is compared with a tolerance of one rung plus one bin.
    public const uint ClockBinMhz = 15;
    // A core rung under a power cap is judged by work, not clock: the sustained half's
    // hash-kernel throughput may not fall more than this under the best certified rung.
    public const double ThroughputRegression = 0.03;
    // Stage 2 for memory: GDDR7 corrects silently and just gets slower, so bandwidth this
    // far under the best seen at a lower rung is the memory failing, not noise. The worker
    // alone repeats within half a percent; under the collector's 2 Hz sampling it spread 9 %
    // on the dev box (plan risk R4), so the floor is also measured: three times the spread
    // of the baseline rung's own passes, whichever is larger.
    public const double BandwidthRegression = 0.03;
    public const double NoiseFloorMultiple = 3;
    // A thermal-limit bit on more than this share of the sustained half's samples ends the
    // ladder: the cooler, not the clock, is the limit. The power cap is the normal state
    // of a sustained half (plan section 16) and is only reported.
    public const double ThermalFractionLimit = 0.05;
    // The cooler's or the board's limit, the one set the ladder ends on and the page's live
    // pill names (src/analysis/nvmlBits.ts THERMAL_OR_BRAKE): HwSlowdown, SwThermalSlowdown,
    // HwThermalSlowdown, HwPowerBrakeSlowdown (dependencies.md).
    public const ulong ThermalBits = 0x8 | 0x20 | 0x40 | 0x80;
    // Every limit bit, for the reported share: SwPowerCap, HwSlowdown, SwThermalSlowdown,
    // HwThermalSlowdown, HwPowerBrakeSlowdown; 0x400 and GpuIdle are load indicators.
    public const ulong ThrottleBits = 0x4 | 0x8 | 0x20 | 0x40 | 0x80;
    // A scored run whose repeats' bandwidths disagree by more than this proves nothing about the memory.
    public const double SweepSpreadLimit = 0.10;

    /// <summary>A rung is a minute (plan section 16): 30 s variable (heavy bursts 2–4 s
    /// apart with light or idle gaps, hash-checked on every burst, the top of the curve
    /// measured), then 30 s sustained (hash-checked on every dispatch, the throughput, the
    /// held clocks and the closing stream pass that score it). Both ladders run the same shape.</summary>
    public static readonly (TunePattern Pattern, int Seconds)[] RungShape =
        [(TunePattern.Variable, 30), (TunePattern.Sustained, 30)];

    /// <summary>The as-found card and the certified pair are scored over two repeats of the shape: two minutes.</summary>
    public const int ScoredRepeats = 2;

    /// <summary>After the restore the card's held clocks are read under this much sustained
    /// load: the same load the as-found figure came from, so the two compare (the light load's
    /// SM clock is the boost governor bouncing, not a figure to compare anything with).</summary>
    public const int HoldsNowSeconds = 10;

    /// <summary>A bandwidth fall is confirmed against the baseline re-measured under this much
    /// sustained load before it counts as stage 2 (TuneHunt.ReconsiderBandwidthAsync): the
    /// stream pass reads in two modes on the dev box and the mode, not the rung, must not fail
    /// the ladder.</summary>
    public const int BandwidthCheckSeconds = 10;

    /// <summary>The end-of-run truth (plan section 16, rule 4): held clocks after the restore
    /// more than this far from the card as found mean the user must re-apply in the vendor tool.</summary>
    public const double HoldsNowTolerance = 0.01;

    public static bool HoldsDiffer(HeldClocks asFound, HeldClocks now) =>
        Math.Abs((double)now.SmMhz - asFound.SmMhz) > HoldsNowTolerance * asFound.SmMhz
        || Math.Abs((double)now.MemMhz - asFound.MemMhz) > HoldsNowTolerance * asFound.MemMhz;

    public static int StepKhz(TuneLadderKind ladder) => ladder == TuneLadderKind.Core ? CoreStepKhz : MemStepKhz;
    public static int ResolutionKhz(TuneLadderKind ladder) => ladder == TuneLadderKind.Core ? CoreResolutionKhz : MemResolutionKhz;

    /// <summary>The next rung above the current one, or null at the driver's ceiling.</summary>
    public static int? NextRung(int currentKhz, int stepKhz, int maxKhz) =>
        currentKhz + stepKhz <= maxKhz ? currentKhz + stepKhz : null;

    /// <summary>The rung to test between the last certified and the first failing value,
    /// halfway down to the resolution's grid, or null once the gap is at the resolution:
    /// the last certified value is the result. A 15 MHz rung bisects to 5 and 10.</summary>
    public static int? Midpoint(int stableKhz, int failingKhz, int resolutionKhz)
    {
        var gap = failingKhz - stableKhz;
        return gap > resolutionKhz ? stableKhz + Math.Max(resolutionKhz, gap / 2 / resolutionKhz * resolutionKhz) : null;
    }

    /// <summary>A vendor tool's tune on the card (plan section 16, 'Another tool's tune'): a
    /// held clock above the driver's clock ceiling plus our own P0 offset plus a bin is an
    /// offset applied by a route this one does not read. Measured on the dev box, the route
    /// does not add to it either: the first NvAPI_GPU_SetPstates20 write, even 0 / 0, took
    /// GPU Tweak's +319 / +4072 off the card (memory 16008 → 14001 within the rung), so a
    /// foreign tune is refused before anything is written. Unknown ceilings cannot tell.</summary>
    public static bool ForeignTune(uint heldMhz, uint? ceilingMhz, int ourOffsetMhz) =>
        ceilingMhz is { } c && heldMhz > c + ourOffsetMhz + ClockBinMhz;

    // The memory clock holds the ceiling plus the offset exactly, so the vendor value the user
    // typed is checked against the card as found within this: GPU Tweak's +4072 (2036 NVML)
    // against 16008 - 14001 = 2007 held is 29 off and passes; a stale +3672 (1836) is 171 off
    // and does not. The core cannot be checked under a power cap and is trusted; the vendor
    // rung's own measurement guards it.
    public const uint VendorMatchMhz = 60;

    public static bool VendorMatches(uint heldMhz, uint ceilingMhz, int vendorNvmlMhz) =>
        Math.Abs((long)heldMhz - ceilingMhz - vendorNvmlMhz) <= VendorMatchMhz;

    /// <summary>The arithmetic behind a passed memory cross-check, for the log and the run's
    /// event line, so a reader sees the numbers and not only the verdict (16041 − 14001 = 2040
    /// against +2036 entered on the dev box); the ceiling unknown means nothing was checked.</summary>
    public static string CrossCheckLine(uint heldMemMhz, uint? ceilingMemMhz, int vendorNvmlMhz) =>
        ceilingMemMhz is { } c
            ? $"memory cross-check: {heldMemMhz} held − {c} ceiling = {(long)heldMemMhz - c} NVML MHz against +{vendorNvmlMhz} entered, within {VendorMatchMhz}"
            : "memory cross-check skipped: the driver reports no memory clock ceiling";

    /// <summary>The user's tune written through our route must hold what the card as found
    /// held: the memory clock within the match, the SM peak within twice it, because at a
    /// power cap the peak wobbles a bin or two between passes (3210–3225 on the dev box).</summary>
    public static bool VendorReproduced(HeldClocks asFound, HeldClocks written) =>
        Math.Abs((long)asFound.SmMhz - written.SmMhz) <= 2 * VendorMatchMhz && Math.Abs((long)asFound.MemMhz - written.MemMhz) <= VendorMatchMhz;

    /// <summary>What the as-found measurement decides before the first write (plan section 16,
    /// 'a P0 delta write replaces the vendor tool's offset', rules 1–3). A refusal names the
    /// stop reason and the sentence and nothing is written; otherwise the baseline the rungs
    /// sit on and every restore puts back, the vendor values (slider units) the export speaks
    /// in, and whether the baseline must first be written and measured as the vendor rung.</summary>
    public sealed record VendorPlan(TuneStopReason? Refusal, string? Sentence, TuneDeltas Baseline, PstateDeltas? Vendor, bool VendorRung);

    /// <summary>
    /// <paramref name="topSmMhz"/> is the highest SM clock seen as found (the variable half's top of
    /// the curve, or the sustained peak), <paramref name="found"/> the P0 deltas the driver reports
    /// as ours, <paramref name="vendor"/> what the user entered (null or 0 / 0 is nothing).
    /// Rules: a clock above the driver's ceiling plus our own P0 offset plus a bin is a tune by a
    /// route ours replaces (foreign); foreign with nothing entered refuses; the memory value
    /// entered is checked against held − ceiling (16008 − 14001 = 2007 NVML against +4072 ÷ 2 =
    /// 2036: 29 off, within 60, passes; a stale +3672 is 171 off and fails; a card at stock
    /// against any non-zero value fails: the tune is not applied on the card); a foreign core
    /// with core +0 entered refuses (the write would wipe it); with nothing foreign the P0
    /// deltas the driver reads are the baseline (a value entered that they already reproduce
    /// is kept for the export, one they do not is refused as not on the card); with a foreign
    /// tune the entered value becomes the baseline, written and measured as the vendor rung
    /// before any step.
    /// </summary>
    public static VendorPlan PlanVendor(HeldClocks held, uint? topSmMhz, uint? ceilingSmMhz, uint? ceilingMemMhz, TuneDeltas found, PstateDeltas? vendor)
    {
        var top = Math.Max(held.SmMhz, topSmMhz ?? 0);
        var foreignCore = ForeignTune(top, ceilingSmMhz, found.CoreMhz);
        var foreignMem = ForeignTune(held.MemMhz, ceilingMemMhz, found.MemMhz);
        var where = $"it holds {held.SmMhz} / {held.MemMhz} MHz under sustained load ({top} MHz at the top of the curve) against the driver's {ceilingSmMhz?.ToString() ?? "unknown"} / {ceilingMemMhz?.ToString() ?? "unknown"} MHz ceilings, with P0 offsets of {found.CoreMhz} / {found.MemMhz} MHz";
        var entered = vendor is { } v0 && (v0.CoreMhz != 0 || v0.MemMhz != 0) ? v0 : null;
        if (entered is null)
        {
            if (foreignCore || foreignMem)
                return new(TuneStopReason.ForeignTune,
                    $"your card holds a tune we cannot see — enter what your vendor tool shows first ({where}): on this driver our offsets replace that tune instead of adding to it, so nothing was written; with the tool's values the hunt writes your tune plus each step and puts your tune back, or zero the tool's offsets and hunt from stock",
                    found, null, false);
            return new(null, null, found, null, false);
        }
        var deltas = VendorUnits.Deltas(entered);
        if (ceilingMemMhz is { } memCeiling && (entered.MemMhz != 0 || foreignMem))
        {
            var above = (long)held.MemMhz - memCeiling;
            if (Math.Abs(above - deltas.MemMhz) > VendorMatchMhz)
                return new(TuneStopReason.VendorMismatch,
                    above <= ClockBinMhz
                        ? $"the memory value entered is not on the card: it holds {held.MemMhz} MHz under load, the driver's {memCeiling} MHz ceiling with nothing on top, while you entered +{entered.MemMhz} (+{deltas.MemMhz} NVML MHz); press Apply in the vendor tool and check what the card holds, or clear the value to hunt from stock; nothing was written"
                        : $"the memory value entered does not match what the card holds: {held.MemMhz} MHz is the {memCeiling} MHz ceiling plus {above} NVML MHz (about +{above * VendorUnits.MemoryFactor} on the slider), you entered +{entered.MemMhz} (+{deltas.MemMhz} NVML MHz); check the tool (a value that sat on its slider without an Apply is not on the card); nothing was written",
                    found, null, false);
        }
        if (foreignCore && entered.CoreMhz == 0)
            return new(TuneStopReason.VendorMismatch,
                $"a core offset is on the card by a route we cannot see ({where}), but you entered core +0: our first write would wipe it; enter the core value the vendor tool shows; nothing was written",
                found, null, false);
        if (!foreignCore && !foreignMem)
        {
            // Our own route already holds the value entered (a previous hunt restored it): the
            // driver's deltas are the baseline and the entered value stays for the export.
            if (Math.Abs(found.CoreMhz - deltas.CoreMhz) <= ClockBinMhz && Math.Abs(found.MemMhz - deltas.MemMhz) <= ClockBinMhz)
                return new(null, null, found, entered, false);
            return new(TuneStopReason.VendorMismatch,
                $"the values entered (core +{entered.CoreMhz} / memory +{entered.MemMhz}) are not on the card: {where}, inside the driver's ceilings; press Apply in the vendor tool and check what the card holds, or clear the values to hunt from stock; nothing was written",
                found, null, false);
        }
        return new(null, null, deltas, entered, true);
    }

    /// <summary>The additivity check: the held clock must have risen by about the offset written so far.</summary>
    public static bool Additive(uint heldMhz, uint baselineHeldMhz, int offsetMhz) =>
        heldMhz >= baselineHeldMhz + AdditivityShare * offsetMhz;

    public enum Additivity { Passed, Undecided, Failed }

    /// <summary>
    /// What the climb knows about additivity after a rung at <paramref name="offsetMhz"/>
    /// above the baseline: passed once the held clock is up by the share of the whole offset;
    /// failed when it fell (the write replaced the tune) or when two rungs are on and it still
    /// has not shown; undecided in between, so a first rung that reads half a bin up is left to
    /// the second.
    /// </summary>
    public static Additivity JudgeAdditivity(uint heldMhz, uint baselineHeldMhz, int offsetMhz, int rungMhz)
    {
        if (Additive(heldMhz, baselineHeldMhz, offsetMhz))
            return Additivity.Passed;
        if (heldMhz < baselineHeldMhz || offsetMhz >= 2 * rungMhz)
            return Additivity.Failed;
        return Additivity.Undecided;
    }

    /// <summary>The vendor-tool guard (plan section 16, narrowed to the card as found): a tune
    /// that is applied and steady is the baseline; a tool that re-applies a profile mid-run
    /// moves the held clock while our offset is constant. Moved is a held clock more than a
    /// rung plus a bin away from where the baseline plus our offset puts it. The memory clock
    /// holds the ceiling plus the offset exactly, so this linear rule is the memory ladder's.</summary>
    public static bool Moved(uint heldMhz, uint baselineHeldMhz, int offsetMhz, int rungMhz)
    {
        var expected = baselineHeldMhz + offsetMhz;
        return Math.Abs((long)heldMhz - expected) > rungMhz + ClockBinMhz;
    }

    /// <summary>The core ladder's movement guard: the top of the curve stops tracking the offset
    /// where the VF table ends (3337 MHz on the dev box, whatever the offset), so the core is
    /// judged against the previous certified rung's own top instead: a drop or a jump of more
    /// than a rung plus a bin between consecutive rungs, while our delta rose by one rung, is
    /// another tool moving the clock. With no previous rung the linear rule applies once.</summary>
    public static bool MovedFromPrevious(uint topMhz, uint? previousTopMhz, uint baselineTopMhz, int offsetMhz, int rungMhz) =>
        previousTopMhz is { } previous
            ? Math.Abs((long)topMhz - previous) > rungMhz + ClockBinMhz
            : Moved(topMhz, baselineTopMhz, offsetMhz, rungMhz);

    // The second and third additivity signals on a power-capped card (plan section 16, 'A core
    // cap, and the top of the clock table'): a core offset that cannot lift the top of the curve
    // still shifts the V/F curve where the card runs, on the cap, as a higher sustained mean
    // clock at the same watts and more work per second. Both are judged against the as-found
    // run's own spread as the noise floor, never below these: the sustained mean wanders a few
    // MHz between minutes even with nothing changed, and the throughput repeats to a few tenths
    // of a percent (3889.73 against 3888.35 Gsteps/s on the dev box, run 154463d9b2f1).
    public const double MeanClockNoiseFloorMhz = 5;
    public const double ThroughputNoiseFloor = 0.003;

    /// <summary>The noise floor for the sustained mean clock: the as-found repeats' spread in MHz, never under the floor.</summary>
    public static double MeanClockNoiseMhz(double? baselineSpreadMhz) => Math.Max(MeanClockNoiseFloorMhz, baselineSpreadMhz ?? 0);

    /// <summary>The noise floor for the sustained throughput: three times the as-found repeats' relative spread, never under the floor.</summary>
    public static double ThroughputNoise(double? baselineSpread) => Math.Max(ThroughputNoiseFloor, NoiseFloorMultiple * (baselineSpread ?? 0));

    /// <summary>
    /// Whether a core rung gained anything where the card actually runs: its sustained mean SM
    /// clock rose over the reference by more than the clock noise, or its sustained throughput
    /// rose by more than the throughput noise. Tonight's numbers: the +15 rung read 3927.12
    /// against 3889 Gsteps/s as found (+1.0 %) while the top of the curve read 3337 both times.
    /// A figure that is missing on either side cannot show a gain.
    /// </summary>
    public static bool GainedOnCap(double? meanSmMhz, double? referenceMeanSmMhz, double clockNoiseMhz, double? throughputGsps, double? referenceThroughputGsps, double throughputNoise)
    {
        var clockRose = meanSmMhz is { } m && referenceMeanSmMhz is { } rm && m > rm + clockNoiseMhz;
        var workRose = throughputGsps is { } t && referenceThroughputGsps is { } rt && rt > 0 && t > rt * (1 + throughputNoise);
        return clockRose || workRose;
    }

    /// <summary>The user's cap: a rung whose predicted clock (the reference clock plus the offset it would write) would pass "never test above" is not written.</summary>
    public static bool CapExceeded(uint referenceMhz, int offsetMhz, int? capMhz) => capMhz is { } cap && referenceMhz + offsetMhz > cap;

    /// <summary>The ladders an official run's failure steps down one fine step (plan section 16:
    /// 'a failure in the 2-minute run steps the failing ladder down one fine step and re-runs
    /// it once'): a bandwidth regression names the memory, a throughput fall the core; a silent
    /// error or a driver reset names neither, so both come down.</summary>
    public static IReadOnlyList<TuneLadderKind> FailingLadders(TuneStopReason reason) => reason switch
    {
        TuneStopReason.Bandwidth => [TuneLadderKind.Memory],
        TuneStopReason.Throughput => [TuneLadderKind.Core],
        _ => [TuneLadderKind.Memory, TuneLadderKind.Core],
    };

    /// <summary>One fine step down on the given ladders, never below the baseline.</summary>
    public static TuneDeltas StepDown(TuneDeltas deltas, TuneDeltas baseline, IReadOnlyList<TuneLadderKind> ladders)
    {
        var core = ladders.Contains(TuneLadderKind.Core) ? Math.Max(baseline.CoreKhz, deltas.CoreKhz - CoreResolutionKhz) : deltas.CoreKhz;
        var mem = ladders.Contains(TuneLadderKind.Memory) ? Math.Max(baseline.MemKhz, deltas.MemKhz - MemResolutionKhz) : deltas.MemKhz;
        return new(core, mem);
    }

    /// <summary>The held clock is within a bin of the driver's clock ceiling: no rung above can show.</summary>
    public static bool AtCeiling(uint heldMhz, uint? ceilingMhz) => ceilingMhz is { } c && heldMhz + ClockBinMhz >= c;

    /// <summary>The share of the best a rung may fall below before it is a regression: the
    /// fixed 3 %, or three times the noise the baseline rung showed, whichever is more.</summary>
    public static double RegressionFloor(double? baselineSpread) =>
        Math.Max(BandwidthRegression, NoiseFloorMultiple * (baselineSpread ?? 0));

    public static bool Regressed(double bandwidthGBs, double? bestGBs, double? baselineSpread = null) =>
        bestGBs is { } best && best > 0 && bandwidthGBs < best * (1 - RegressionFloor(baselineSpread));

    public static bool ThroughputFell(double throughput, double? best) =>
        best is { } b && b > 0 && throughput < b * (1 - ThroughputRegression);

    public static double Median(IReadOnlyList<double> values)
    {
        var sorted = values.Order().ToArray();
        return sorted.Length % 2 == 1 ? sorted[sorted.Length / 2] : (sorted[sorted.Length / 2 - 1] + sorted[sorted.Length / 2]) / 2;
    }

    /// <summary>(max - min) / median: the relative spread of a rung's passes.</summary>
    public static double Spread(IReadOnlyList<double> values)
    {
        if (values.Count < 2)
            return 0;
        var median = Median(values);
        return median > 0 ? (values.Max() - values.Min()) / median : 0;
    }

    /// <summary>One pattern's verdict from what the worker said: a device loss (stage 3,
    /// exit 10 or a dead heartbeat), a hash mismatch (stage 1, exit 2), or a pass that the
    /// rung's judgement takes further. Null for an exit that is not a verdict at all
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

    /// <summary>The rung's verdict once every pass's hash matched: the cooler's limit first
    /// (invalid, the ladder ends), then a scored run whose repeats' bandwidths disagree
    /// (invalid), then stage 2: a core rung's sustained throughput under the best certified,
    /// or a memory rung's bandwidth under the best; else stable. A power cap is not asked about.</summary>
    public static (TuneVerdict Verdict, int? Stage, TuneStopReason? Stop) Judge(TuneLadderKind ladder, double thermalFraction, double? throughput, double? bestThroughput, double? bandwidth, double? bestBandwidth, double spread, double? baselineSpread)
    {
        if (thermalFraction > ThermalFractionLimit)
            return (TuneVerdict.Invalid, null, TuneStopReason.Thermal);
        if (ladder == TuneLadderKind.Memory && spread > SweepSpreadLimit)
            return (TuneVerdict.Invalid, null, TuneStopReason.Inconsistent);
        if (ladder == TuneLadderKind.Core && throughput is { } t && ThroughputFell(t, bestThroughput))
            return (TuneVerdict.Unstable, 2, TuneStopReason.Throughput);
        if (ladder == TuneLadderKind.Memory && bandwidth is { } bw && Regressed(bw, bestBandwidth, baselineSpread))
            return (TuneVerdict.Unstable, 2, TuneStopReason.Bandwidth);
        return (TuneVerdict.Stable, null, null);
    }

    /// <summary>The failure-ladder stage of a stop reason: 1 silent error, 2 throughput or
    /// bandwidth regression, 3 a driver reset; null for the stops that are not failures.</summary>
    public static int? Stage(TuneStopReason reason) => reason switch
    {
        TuneStopReason.Hash => 1,
        TuneStopReason.Throughput or TuneStopReason.Bandwidth => 2,
        TuneStopReason.DeviceLost => 3,
        _ => null,
    };

    /// <summary>A stop that names a real failure of the silicon at that rung (stages 1–3).</summary>
    public static bool IsFailure(TuneStopReason reason) => Stage(reason) is not null;

    /// <summary>The card was left untouched by the ladder: a refusal before, or at, the first write.</summary>
    public static bool IsRefusal(TuneStopReason reason) => reason is TuneStopReason.ForeignTune or TuneStopReason.VendorMismatch or TuneStopReason.Additivity;

    /// <summary>A ladder converged when it ended on a failure of the silicon or on the card's own limit: the driver's range or clock ceiling, or the top of the clock table.</summary>
    public static bool Converged(TuneStopReason reason) => IsFailure(reason) || reason is TuneStopReason.DriverMax or TuneStopReason.Ceiling or TuneStopReason.TopOfTable;

    /// <summary>High: every ladder found its failure and bisected it with nothing in the way.
    /// Medium: it was found, but a device loss or an invalid rung sits in the record, or a
    /// ladder ran into the driver's range or clock ceiling. Low: a ladder did not get there
    /// (the cap, the cooler, a driver that does not add), or nothing above the card as
    /// found held.</summary>
    public static TuneConfidence Confidence(bool converged, bool atDriverMax, int deviceLostCount, bool anyInvalid, bool aboveBaseline)
    {
        if (!converged || !aboveBaseline)
            return TuneConfidence.Low;
        return deviceLostCount > 0 || anyInvalid || atDriverMax ? TuneConfidence.Medium : TuneConfidence.High;
    }
}
