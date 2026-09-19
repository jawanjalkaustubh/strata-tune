using System.Text.Json.Serialization;

namespace StrataTune.Shared;

/// <summary>A core / memory pair in MHz: the applied P0 clock offsets as NVAPI reports them
/// for the GPU facts, the certified offsets of a result, and the same offsets in a vendor
/// slider's units. Null on a card or driver without the pstate interface.</summary>
public sealed record PstateDeltas(int CoreMhz, int MemMhz);

/// <summary>The one conversion between our units and the vendor sliders' (mirrored and
/// tested in src/analysis/tune.ts vendorSlider): GPU Tweak III and Afterburner take the
/// core in MHz as we do and the memory as the effective data rate, twice NVML's memory
/// clock. Verified on the dev box twice: GPU Tweak's +4072 on the 14001 MHz ceiling is
/// +2036 NVML → 16037, and NVML read 16032 (a 5 MHz rounding); its dropped-apply case,
/// +3672 on the slider, is +1836 NVML → 15837, exactly the clock the card held (plan
/// section 16).</summary>
public static class VendorUnits
{
    public const int MemoryFactor = 2;

    public static PstateDeltas Slider(PstateDeltas ours) => new(ours.CoreMhz, ours.MemMhz * MemoryFactor);

    /// <summary>What the vendor tool shows, as the P0 deltas that reproduce it through our
    /// route (plan section 16, 'a P0 delta write replaces the vendor tool's offset'): the
    /// core as is, the slider's effective memory rate halved to NVML MHz.</summary>
    public static TuneDeltas Deltas(PstateDeltas slider) => new(slider.CoreMhz * 1000, slider.MemMhz / MemoryFactor * 1000);

    /// <summary>The whole tune in the slider's units: what the user types once the hunt is
    /// done, the vendor tool's own values plus what was certified on top.</summary>
    public static PstateDeltas Total(PstateDeltas vendor, PstateDeltas certified) =>
        new(vendor.CoreMhz + certified.CoreMhz, vendor.MemMhz + certified.MemMhz * MemoryFactor);
}

/// <summary>NVAPI's own unit: a P0 frequency delta in kHz for the graphics and memory
/// domains, exact for the revert; the MHz pair is what the page and the OC tools show.</summary>
public sealed record TuneDeltas(int CoreKhz, int MemKhz)
{
    public int CoreMhz => (int)Math.Round(CoreKhz / 1000.0);
    public int MemMhz => (int)Math.Round(MemKhz / 1000.0);
}

/// <summary>What NvAPI_GPU_GetPstates20 answered: the deltas plus the range the driver
/// allows for each, and whether the entries are editable at all.</summary>
public sealed record PstateDeltaRange(TuneDeltas Deltas, int CoreMinKhz, int CoreMaxKhz, int MemMinKhz, int MemMaxKhz, bool Editable);

/// <summary>The clocks NVML saw the card hold under the heavy pattern: the card as found at
/// the baseline (a vendor tool's tune included), and again at the certified rungs.</summary>
public sealed record HeldClocks(uint SmMhz, uint MemMhz);

/// <summary>Plan section 16's state machine as trimmed on 2026-09-16: IDLE (nothing of ours
/// is on the card) → PENDING (a rung is on the card; written to disk before the apply) →
/// IDLE. REVERTED is only the attribution shown after a crash, which rung was on the card
/// when the machine or the collector died, until the next run starts.</summary>
public enum TuneRollback
{
    [JsonStringEnumMemberName("IDLE")] Idle,
    [JsonStringEnumMemberName("PENDING")] Pending,
    [JsonStringEnumMemberName("REVERTED")] Reverted,
}

/// <summary>hunt is the memory ladder followed by the core ladder, each from the card as
/// found; core and memory run one ladder alone.</summary>
public enum TuneRunKind
{
    [JsonStringEnumMemberName("hunt")] Hunt,
    [JsonStringEnumMemberName("core")] Core,
    [JsonStringEnumMemberName("memory")] Memory,
}

public enum TuneLadderKind
{
    [JsonStringEnumMemberName("core")] Core,
    [JsonStringEnumMemberName("memory")] Memory,
}

public enum TuneRunState
{
    [JsonStringEnumMemberName("running")] Running,
    [JsonStringEnumMemberName("done")] Done,
    [JsonStringEnumMemberName("failed")] Failed,
    [JsonStringEnumMemberName("stopped")] Stopped,
}

/// <summary>The two halves of a rung (plan section 16, 'a rung is a minute of realistic
/// load'): variable is 30 s of heavy bursts 2–4 s apart with light or idle gaps, the clock
/// and voltage transitions where a marginal offset fails, hash-checked on every burst;
/// sustained is 30 s of full load, hash-checked on every dispatch, whose throughput and
/// closing stream pass are the rung's score.</summary>
public enum TunePattern
{
    [JsonStringEnumMemberName("variable")] Variable,
    [JsonStringEnumMemberName("sustained")] Sustained,
}

/// <summary>Where a run is: the reference hash; the as-found scored run (two minutes, nothing
/// written); the vendor rung (the user's tune written through our route); the climb in
/// rungs; the bisect between the last certified rung and the first failing one; the
/// official scored run of the certified pair; putting the baseline back; measuring what the
/// card holds after that.</summary>
public enum TunePhase
{
    [JsonStringEnumMemberName("reference")] Reference,
    [JsonStringEnumMemberName("as-found")] AsFound,
    [JsonStringEnumMemberName("vendor")] Vendor,
    [JsonStringEnumMemberName("climb")] Climb,
    [JsonStringEnumMemberName("bisect")] Bisect,
    [JsonStringEnumMemberName("official")] Official,
    [JsonStringEnumMemberName("restore")] Restore,
    [JsonStringEnumMemberName("holds-now")] HoldsNow,
}

/// <summary>Per rung: stable (every pattern's hash matched, throughput and bandwidth held),
/// unstable at a ladder stage, invalid (the rung says nothing about the silicon: the cooler
/// limited it, the sweep's passes disagreed, another tool wrote the offsets), or device
/// lost (stage 3, a TDR).</summary>
public enum TuneVerdict
{
    [JsonStringEnumMemberName("stable")] Stable,
    [JsonStringEnumMemberName("unstable")] Unstable,
    [JsonStringEnumMemberName("invalid")] Invalid,
    [JsonStringEnumMemberName("device-lost")] DeviceLost,
}

/// <summary>The live validity indicator: a thermal-limit bit under the heavy pattern makes
/// the run 'throttled' (the cooler, not the clock, is the limit); a power cap does not.</summary>
public enum TuneValidity
{
    [JsonStringEnumMemberName("ok")] Ok,
    [JsonStringEnumMemberName("throttled")] Throttled,
    [JsonStringEnumMemberName("unknown")] Unknown,
}

public enum TuneConfidence
{
    [JsonStringEnumMemberName("high")] High,
    [JsonStringEnumMemberName("medium")] Medium,
    [JsonStringEnumMemberName("low")] Low,
}

/// <summary>Why a ladder ended. hash, throughput / bandwidth and device-lost are the
/// failure ladder's stages 1, 2 and 3 (the first real failure is what the result names);
/// thermal is the cooler; inconsistent is a sweep step whose passes disagreed;
/// foreign-tune is a vendor tool's tune found on the card before anything was written
/// (our route would replace it, so nothing was) with no value entered for it;
/// vendor-mismatch is a value entered that the card as found does not bear out (also
/// before anything was written); additivity is a first rung the driver did not add on top
/// of the card as found; driver-max and ceiling are the driver's offset range and clock
/// ceiling; cap is the request's rung limit.</summary>
public enum TuneStopReason
{
    [JsonStringEnumMemberName("hash")] Hash,
    [JsonStringEnumMemberName("throughput")] Throughput,
    [JsonStringEnumMemberName("bandwidth")] Bandwidth,
    [JsonStringEnumMemberName("device-lost")] DeviceLost,
    [JsonStringEnumMemberName("thermal")] Thermal,
    [JsonStringEnumMemberName("inconsistent")] Inconsistent,
    [JsonStringEnumMemberName("foreign-tune")] ForeignTune,
    [JsonStringEnumMemberName("vendor-mismatch")] VendorMismatch,
    [JsonStringEnumMemberName("additivity")] Additivity,
    [JsonStringEnumMemberName("driver-max")] DriverMax,
    [JsonStringEnumMemberName("ceiling")] Ceiling,
    [JsonStringEnumMemberName("cap")] Cap,
    // A core ladder whose offsets moved neither the top of the curve, the sustained clock nor
    // the throughput (plan section 16: the card already runs at the top of its clock table;
    // certified +0 core, a result and not a failure), and the user's own "never test above".
    [JsonStringEnumMemberName("top-of-table")] TopOfTable,
    [JsonStringEnumMemberName("user-cap")] UserCap,
}

/// <summary>How one ladder ended: the offset (MHz above the baseline P0 delta) at which it
/// stopped, the failure-ladder stage when the reason is one, and the sentence.</summary>
public sealed record TuneLadderStop(TuneLadderKind Ladder, TuneStopReason Reason, int OffsetMhz, int? Stage, string Note);

/// <summary>The crash the last start found: the rung that was on the card, the baseline that
/// replaced it, when, why, and the ladder stage (4, a hard hang).</summary>
public sealed record TuneReverted(TuneDeltas Candidate, TuneDeltas Baseline, string At, string Reason, int Stage);

public sealed record TuneHistoryEntry(string At, TuneRollback State, TuneDeltas? Candidate, string Note);

/// <summary>Plan section 16, 'every rung is scored': one fixed scale on which a reference
/// RTX 5090 at its reference clocks (2407 MHz boost, 28 Gbps memory) scores 10,000, half
/// for compute and half for bandwidth, so numbers compare across cards and across people.
/// The compute reference is the worker's own hash kernel at 2407 MHz: measured on the dev
/// box's 5090 at 3502.40 Gsteps/s with the SM clock held at 2947 MHz (sustained load at the
/// 600 W cap), one step costs 21760 lanes × 2947 MHz ÷ 3502.40 G = 18.3 lane-clocks, so at
/// 2407 MHz the reference does 21760 × 2407 MHz ÷ 18.3 = 3502.40 × 2407 ÷ 2947 = 2861
/// Gsteps/s. (The Blackwell whitepaper's 104.8 FP32 TFLOPS is the same 21760 lanes × 2 FLOP
/// × 2407 MHz; the kernel is integer work, so its own measured cost is the honest scale.)
/// The bandwidth reference is the worker's 1 GiB stream copy at the reference 28 Gbps: it
/// reaches about 80 % of the 1792 GB/s bus, 1437 GB/s measured on the dev box at the
/// 14001 MHz (28 Gbps) memory clock. A card's points are its measured figures against these,
/// linearly: 5000 × Gsteps/s ÷ 2861 plus 5000 × GB/s ÷ 1437, rounded. Mirrored and tested
/// in src/analysis/tune.ts.</summary>
public static class TuneScoring
{
    public const int ReferencePoints = 10_000;
    public const int ComputeShare = 5_000, BandwidthShare = 5_000;
    public const double ReferenceComputeGsps = 2861;
    public const double ReferenceBandwidthGBs = 1437;

    public static int ComputePoints(double throughputGsps) => (int)Math.Round(ComputeShare * throughputGsps / ReferenceComputeGsps);

    public static int BandwidthPoints(double bandwidthGBs) => (int)Math.Round(BandwidthShare * bandwidthGBs / ReferenceBandwidthGBs);

    /// <summary>Null without both figures: a rung that failed before its sustained half has no score.</summary>
    public static TuneScore? Score(double? throughputGsps, double? bandwidthGBs) =>
        throughputGsps is { } t && bandwidthGBs is { } b ? new TuneScore(ComputePoints(t) + BandwidthPoints(b), ComputePoints(t), BandwidthPoints(b), t, b) : null;

    /// <summary>"+1.1 % over your current tune": the relative change of one score against another, in percent.</summary>
    public static double PercentOver(int points, int over) => over > 0 ? (points - over) * 100.0 / over : 0;
}

/// <summary>A rung's or a scored run's points: the total and its two halves, with the
/// measured figures they came from (the sustained half's hash-kernel throughput and the
/// closing stream pass's bandwidth).</summary>
public sealed record TuneScore(int Points, int ComputePoints, int BandwidthPoints, double ThroughputGsps, double BandwidthGBs);

/// <summary>Average and peak of one telemetry figure over a scored run's samples.</summary>
public sealed record TelemetryStat(double Avg, double Max);

/// <summary>The GPU over a scored run, from the flight recorder's samples: clocks, temperatures
/// (hotspot and memory junction only when the library reads them on this card), board power
/// against its cap, the share of samples under each limit reason, and the fan duty. A figure
/// this card does not report is null and the sheet leaves its row out.</summary>
public sealed record GpuTelemetry(
    TelemetryStat CoreMhz,
    TelemetryStat MemMhz,
    TelemetryStat CoreC,
    TelemetryStat? HotspotC,
    TelemetryStat? MemoryJunctionC,
    TelemetryStat BoardW,
    double PowerCapW,
    IReadOnlyDictionary<string, double> LimitShare,
    TelemetryStat? FanPercent);

/// <summary>The CPU over the same samples: effective clock (avg of the per-sample average,
/// max of the per-sample peak core), package power and Tctl. Null on a box where the
/// library does not read the CPU (no PawnIO, ARM64).</summary>
public sealed record CpuTelemetry(TelemetryStat? EffectiveMhz, TelemetryStat? PackageW, TelemetryStat? TctlC);

/// <summary>What the flight recorder saw during a scored run: the .html comparison sheet's
/// per-component tables (plan section 16, 'Save as .html').</summary>
public sealed record TelemetrySummary(int Samples, double Seconds, GpuTelemetry? Gpu, CpuTelemetry? Cpu);

/// <summary>A scored run: the as-found card (two minutes, nothing written) or the official
/// run of the certified pair (two minutes at those offsets). <see cref="Repeats"/> is how
/// many times the 60 s shape ran; <see cref="Score"/> is from the mean of the sustained
/// halves' throughput and the stream passes' bandwidth; <see cref="Held"/> the peak clocks
/// under the sustained halves and <see cref="TopSmMhz"/> under the variable halves; a run
/// that failed a stage has the verdict and no score. <see cref="SteppedDown"/> is set on an
/// official run that failed once and was re-run one fine step lower on the failing ladder.</summary>
public sealed record ScoredRun(
    TuneDeltas Deltas,
    int Repeats,
    TuneVerdict Verdict,
    TuneScore? Score,
    HeldClocks? Held,
    uint? TopSmMhz,
    string Note,
    TelemetrySummary? Telemetry,
    bool SteppedDown)
{
    /// <summary>The sustained halves' mean SM clock: what a core offset moves on a power-capped card when the top of the curve cannot (plan section 16).</summary>
    public double? MeanSmMhz { get; init; }
}

/// <summary>What a finished hunt found. <see cref="Deltas"/> are the certified P0 offsets
/// (the baseline plus what each ladder certified; equal to the baseline when nothing above
/// it held) and <see cref="Baseline"/> the P0 offsets the run climbed from and restored: the
/// deltas read at the start, or the user's vendor tune written through our route when one
/// was on the card (<see cref="Vendor"/>, in the slider's units, null otherwise).
/// <see cref="BaselineHeld"/> is the card as found under the heavy pattern before anything
/// was written (a vendor tool's tune is inside it), <see cref="HeldAtCertified"/> the same
/// clocks at the certified rungs. <see cref="FirstFailure"/> is the lowest rung that failed
/// a ladder stage after the bisect; <see cref="Stops"/> says how each ladder ended. <see cref="AsFound"/> is the
/// two-minute scored run of the card before anything was written and <see cref="Official"/>
/// the same of the certified pair: the benchmark (plan section 16, 'the final run is the
/// benchmark'). <see cref="HoldsNow"/> is what the card held under a short sustained load
/// after the restore, next to <see cref="BaselineHeld"/>: the end-of-run truth the page shows.</summary>
public sealed record TuneResult(
    TuneRunKind Kind,
    TuneDeltas Deltas,
    TuneDeltas Baseline,
    PstateDeltas? Vendor,
    HeldClocks? BaselineHeld,
    HeldClocks? HeldAtCertified,
    TuneLadderStop? FirstFailure,
    IReadOnlyList<TuneLadderStop> Stops,
    double? BandwidthGBs,
    string ReferenceHash,
    TuneConfidence Confidence,
    string FoundAt)
{
    /// <summary>The offsets on top of the card as found, in MHz: what the user types into the vendor tool.</summary>
    public PstateDeltas Certified => new(Deltas.CoreMhz - Baseline.CoreMhz, Deltas.MemMhz - Baseline.MemMhz);

    public ScoredRun? AsFound { get; init; }
    public ScoredRun? Official { get; init; }
    public HeldClocks? HoldsNow { get; init; }

    /// <summary>Every rung as tested, with its points: the ladder as a score climb, kept with the result across restarts.</summary>
    public IReadOnlyList<TuneCandidate> Rungs { get; init; } = [];
}

/// <summary>%ProgramData%\Strata Tune\tune-state.json. <see cref="OrderlyStop"/> is set when
/// the collector exits through a known path (the shutdown route, the parent gone, a session
/// end) with a rung still PENDING, so the next start reverts it quietly and keeps the hang
/// wording for a marker without it. <see cref="DeviceLosses"/> are the last device-loss
/// times across runs and restarts, for the start cooldown (Windows bug-checks on repeated
/// GPU hangs).</summary>
public sealed record TuneFile(
    bool Enabled,
    TuneRollback State,
    TuneDeltas? Baseline,
    TuneDeltas? Candidate,
    string? AppliedAt,
    bool OrderlyStop,
    TuneReverted? Reverted,
    TuneResult? Result,
    IReadOnlyList<TuneHistoryEntry> History)
{
    public IReadOnlyList<string> DeviceLosses { get; init; } = [];

    /// <summary>The vendor tool's values (slider units) the <see cref="Baseline"/> reproduces,
    /// recorded with the candidate so the revert at the next start says it put the user's
    /// tune back, not 0; null when the baseline is the card's own P0 deltas.</summary>
    public PstateDeltas? Vendor { get; init; }
}

/// <summary>One rung as tested. <see cref="Held"/> is the sustained half's peak SM / memory
/// clock; <see cref="TopSmMhz"/> the peak SM clock under the variable half, the top of the
/// curve where a core offset shows without the power cap in the way;
/// <see cref="ThroughputGsps"/> the sustained half's hash-kernel throughput (10^9 lane
/// steps per second of dispatch time), the figure a core rung must not lower;
/// <see cref="ThrottledFraction"/> the share of sustained samples with any limit bit, shown
/// because a power cap is the normal state of a heavy rung, never a verdict;
/// <see cref="Score"/> the rung's points (null when it failed before its sustained half
/// finished), the ladder shown as a score climb.</summary>
public sealed record TuneCandidate(
    TuneLadderKind Ladder,
    TuneDeltas Deltas,
    TuneVerdict Verdict,
    int? Stage,
    TunePattern? FailedPattern,
    HeldClocks? Held,
    uint? TopSmMhz,
    double? ThroughputGsps,
    double? BandwidthGBs,
    double ThrottledFraction,
    string Note)
{
    public TuneScore? Score { get; init; }

    /// <summary>The sustained half's mean SM clock (the whole 30 s averaged: clocks on a power cap wander a bin or two), the second additivity signal when the top of the curve does not move.</summary>
    public double? MeanSmMhz { get; init; }
}

/// <summary>The live run, on GET /tune/state and as the SSE 'tune' event at 2 Hz: what the
/// monitor page shows beside the sensors (plan section 16, live monitor).</summary>
public sealed record TuneRun(
    string Id,
    TuneRunKind Kind,
    TuneRunState State,
    string StartedAt,
    double ElapsedS,
    TunePhase Phase,
    TuneLadderKind? Ladder,
    TuneDeltas? Candidate,
    int? Stage,
    TunePattern? Pattern,
    double PatternElapsedS,
    int PatternSeconds,
    int DeviceLostCount,
    int ErrorCount,
    double? BandwidthGBs,
    double? BestBandwidthGBs,
    HeldClocks? BaselineHeld,
    TuneValidity Validity,
    string LastEvent,
    IReadOnlyList<TuneCandidate> Candidates,
    TuneResult? Result,
    string? Error)
{
    /// <summary>Which repeat of the 60 s shape a scored run is on (1-based), 0 outside one.</summary>
    public int Repeat { get; init; }

    /// <summary>The as-found scored run once it is done, before any ladder has a result.</summary>
    public ScoredRun? AsFound { get; init; }
}

public sealed record TuneNvapi(bool Available, string? Reason, TuneDeltas? Deltas, PstateDeltaRange? Range);

/// <summary>GET /tune/state: the persisted file's fields, the NVAPI read, the run if one is
/// active, and the facts the page needs to explain itself. <see cref="Problem"/> is what
/// stops Tune altogether (the state file's folder could not be restricted to
/// administrators, the file does not parse, another collector on this machine holds the
/// state).</summary>
public sealed record TuneStatus(
    bool Enabled,
    TuneRollback State,
    TuneDeltas? Baseline,
    TuneDeltas? Candidate,
    string? AppliedAt,
    TuneReverted? Reverted,
    TuneResult? Result,
    IReadOnlyList<TuneHistoryEntry> History,
    TuneNvapi Nvapi,
    TuneRun? Run,
    bool FlightAvailable,
    string StateFile)
{
    public string? Problem { get; init; }

    /// <summary>"About 16 minutes": what a full hunt takes on a typical card (<see cref="TuneTiming"/>), shown before Start.</summary>
    public int EstimateMinutes { get; init; }
}

/// <summary>The time estimate shown before Start (plan section 16: 'shown as a time estimate
/// before the user starts'). A rung is a minute; the as-found and the official scored runs
/// are two minutes each; a typical ladder is six rungs (the climb to its first failure and
/// the bisect), or the request's cap; the vendor rung is one more minute when the user
/// entered a vendor tune: 2 + 6 + 6 + 2 = about 16 minutes for a hunt. Mirrored in
/// src/analysis/tune.ts estimateMinutes.</summary>
public static class TuneTiming
{
    public const int RungMinutes = 1, ScoredRunMinutes = 2, TypicalRungs = 6;

    public static int EstimateMinutes(TuneRunKind kind, int? maxCandidates, bool vendor)
    {
        var ladders = kind == TuneRunKind.Hunt ? 2 : 1;
        var rungs = maxCandidates is > 0 and var cap ? cap : TypicalRungs;
        return ScoredRunMinutes + ladders * rungs * RungMinutes + ScoredRunMinutes + (vendor ? RungMinutes : 0);
    }
}

/// <summary>POST /tune/start. <see cref="Enabled"/> is the UI's own setting, checked beside
/// the state file's flag so neither side can start a hunt alone; a client that omits it
/// is held to the file's flag alone. <see cref="Target"/> is the client's other spelling of the kind.</summary>
public sealed record TuneStartRequest(TuneRunKind? Kind, TuneRunKind? Target, bool? Enabled)
{
    public TuneRunKind EffectiveKind => Kind ?? Target ?? TuneRunKind.Hunt;

    /// <summary>At most this many rungs tried per ladder (the baseline rung not counted),
    /// then the ladder ends with what it has (unconverged, low confidence): a bounded
    /// smoke test on a live card. Null, the default, is unlimited.</summary>
    public int? MaxCandidates { get; init; }

    /// <summary>What the user's vendor tool shows (plan section 16: core in MHz, memory in
    /// the slider's effective-rate units). A tune found on the card by a route our P0 write
    /// would replace is reproduced through our route from this value, climbed from and
    /// restored, never zeroed; without it such a card is refused before anything is written.</summary>
    public PstateDeltas? Vendor { get; init; }

    /// <summary>"Never test above __ MHz" (plan section 16, the user's own caution for a night
    /// run): a rung whose predicted top-of-curve SM clock (core) or memory clock would exceed the
    /// cap is not written and the ladder ends with "stopped at your cap". Null, the default, is no cap.</summary>
    public int? CoreCapMhz { get; init; }
    public int? MemCapMhz { get; init; }
}

/// <summary>POST /tune/enable. On, the acknowledgement of the warning modal travels with
/// it (plan section 27a: date, app version, and the GPU name the collector adds) and is
/// written to the state file's history and the log.</summary>
public sealed record TuneEnableRequest(bool Enabled, string? AcknowledgedAt, string? AppVersion);

/// <summary>GET /tune/export: the value set to type into the vendor tool (plan section 16,
/// output), in our units and in the sliders' units, with the clocks it was measured from.
/// <see cref="SliderTotal"/> is the whole tune to set when the hunt climbed on top of the
/// user's vendor tune (its values plus the certified ones), null when it climbed from stock.</summary>
public sealed record TuneExport(
    PstateDeltas Certified,
    PstateDeltas VendorSlider,
    PstateDeltas? SliderTotal,
    HeldClocks? BaselineHeld,
    HeldClocks? HeldAtCertified,
    TuneLadderStop? FirstFailure,
    string Text,
    TuneConfidence Confidence,
    string MeasuredAt)
{
    /// <summary>The vendor tool's own values the run climbed on top of (slider units), null from stock.</summary>
    public PstateDeltas? Vendor { get; init; }

    /// <summary>The official scored run of the certified pair: the benchmark number and its telemetry for the .html sheet.</summary>
    public ScoredRun? Score { get; init; }

    /// <summary>The as-found card, scored the same way first.</summary>
    public ScoredRun? AsFound { get; init; }

    public int ReferencePoints { get; init; } = TuneScoring.ReferencePoints;

    /// <summary>Every rung as tested, with its points: the ladder as a score climb.</summary>
    public IReadOnlyList<TuneCandidate> Rungs { get; init; } = [];

    /// <summary>What the card held after the restore, beside <see cref="BaselineHeld"/>; null when the run did not get to measure it.</summary>
    public HeldClocks? HoldsNow { get; init; }
}

/// <summary>The one line /health carries about Tune, so a crash revert is visible from the
/// status pill without opening the page. <see cref="RestoreFailure"/> is set while a run's
/// baseline could not be put back (the driver refused every retry): the rung is still
/// on the card and the file stays PENDING until a revert succeeds.</summary>
public sealed record TuneHealth(TuneRollback State, TuneReverted? Reverted, bool RunActive, string? RestoreFailure);
