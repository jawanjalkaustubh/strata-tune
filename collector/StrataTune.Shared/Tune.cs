using System.Text.Json.Serialization;

namespace StrataTune.Shared;

/// <summary>The applied P0 clock offsets as NVAPI reports them, in MHz for the GPU facts
/// (GPU Tweak III and Afterburner speak MHz); the state file keeps NVAPI's kHz exactly.
/// Null on a card or driver without the pstate interface.</summary>
public sealed record PstateDeltas(int CoreMhz, int MemMhz);

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

/// <summary>Plan section 16's rollback state machine. PENDING is written to disk before any
/// apply; VALIDATING is a kept result on the card until the next boot, waiting for that boot
/// to be a clean one after a clean shutdown; KNOWN_GOOD is the only state in which nothing
/// of ours is on the card; REVERTED says the last start found a candidate applied across a
/// crash and put the baseline back.</summary>
public enum TuneRollback
{
    [JsonStringEnumMemberName("KNOWN_GOOD")] KnownGood,
    [JsonStringEnumMemberName("PENDING")] Pending,
    [JsonStringEnumMemberName("VALIDATING")] Validating,
    [JsonStringEnumMemberName("REVERTED")] Reverted,
}

public enum TuneRunKind
{
    [JsonStringEnumMemberName("core")] Core,
    [JsonStringEnumMemberName("memory")] Memory,
    [JsonStringEnumMemberName("validate")] Validate,
}

public enum TuneRunState
{
    [JsonStringEnumMemberName("running")] Running,
    [JsonStringEnumMemberName("done")] Done,
    [JsonStringEnumMemberName("failed")] Failed,
    [JsonStringEnumMemberName("stopped")] Stopped,
}

public enum TunePattern
{
    [JsonStringEnumMemberName("heavy")] Heavy,
    [JsonStringEnumMemberName("light")] Light,
    [JsonStringEnumMemberName("transient")] Transient,
}

/// <summary>Where a run is: reference (the stock hash and bandwidth at the baseline), the
/// coarse ladder, the bisect, the memory sweep, the long validation, or putting the
/// baseline back.</summary>
public enum TunePhase
{
    [JsonStringEnumMemberName("reference")] Reference,
    [JsonStringEnumMemberName("coarse")] Coarse,
    [JsonStringEnumMemberName("bisect")] Bisect,
    [JsonStringEnumMemberName("sweep")] Sweep,
    [JsonStringEnumMemberName("validate")] Validate,
    [JsonStringEnumMemberName("restore")] Restore,
}

/// <summary>Per candidate: stable (every pattern exit 0, no throttle bit), unstable at a
/// ladder stage, invalid (a throttle bit was set during the heavy pattern, so the result
/// says nothing about the silicon), or device lost (stage 3, a TDR).</summary>
public enum TuneVerdict
{
    [JsonStringEnumMemberName("stable")] Stable,
    [JsonStringEnumMemberName("unstable")] Unstable,
    [JsonStringEnumMemberName("invalid")] Invalid,
    [JsonStringEnumMemberName("device-lost")] DeviceLost,
}

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

/// <summary>The crash the last start found: the candidate that was on the card, the
/// baseline that replaced it, when, and why the start decided it was a crash.</summary>
public sealed record TuneReverted(TuneDeltas Candidate, TuneDeltas Baseline, string At, string Reason);

public sealed record TuneHistoryEntry(string At, TuneRollback State, TuneDeltas? Candidate, string Note);

/// <summary>What a finished hunt found, with the baseline it was measured from (the value
/// set is meaningless without it) and the stock-clock hash every candidate was checked
/// against. <see cref="Validated"/> flips after a 'validate' run passes; only then may
/// POST /tune/keep put it on the card. <see cref="Promoted"/> flips when a kept result was
/// on the card through to a clean shutdown and the System log shows no dirty shutdown
/// before the next boot: the plan's known-good. <see cref="ReferenceSmMhz"/> and
/// <see cref="ReferenceMemMhz"/> are the clocks NVML saw during the reference run, so the
/// export says what the card actually ran at (an OC applied by another route than the P0
/// deltas shows there, not in the baseline). <see cref="ThrottledFraction"/> is the share
/// of the validation's heavy samples with a limit bit set: a power-limited card passes
/// validation and says so.</summary>
public sealed record TuneResult(
    TuneRunKind Kind,
    TuneDeltas Deltas,
    TuneDeltas Baseline,
    double? BandwidthGBs,
    string ReferenceHash,
    TuneConfidence Confidence,
    bool Validated,
    string FoundAt)
{
    public bool Promoted { get; init; }
    public uint? ReferenceSmMhz { get; init; }
    public uint? ReferenceMemMhz { get; init; }
    public double? ThrottledFraction { get; init; }
}

/// <summary>%ProgramData%\Strata Tune\tune-state.json. <see cref="CleanShutdown"/> is set by
/// the collector's orderly exit and cleared at its next start; a PENDING or VALIDATING state
/// found without it is a hard crash. <see cref="BootAt"/> is the boot the state was written
/// in: a VALIDATING result is promoted only from a later boot, because the P0 deltas do not
/// survive one. <see cref="DeviceLosses"/> are the last device-loss times across runs and
/// restarts, for the start cooldown (Windows bug-checks on repeated GPU hangs).</summary>
public sealed record TuneFile(
    bool Enabled,
    TuneRollback State,
    TuneDeltas? Baseline,
    TuneDeltas? Candidate,
    string? AppliedAt,
    bool CleanShutdown,
    string? LastCleanShutdown,
    TuneReverted? Reverted,
    TuneResult? Result,
    IReadOnlyList<TuneHistoryEntry> History)
{
    public string? BootAt { get; init; }
    public IReadOnlyList<string> DeviceLosses { get; init; } = [];
}

public sealed record TuneCandidate(
    TuneDeltas Deltas,
    TuneVerdict Verdict,
    int? Stage,
    TunePattern? FailedPattern,
    double? BandwidthGBs,
    double ThrottledFraction,
    string Note);

/// <summary>The live run, on GET /tune/state and as the SSE 'tune' event at 2 Hz: what the
/// monitor page shows beside the sensors (plan section 16, live monitor).</summary>
public sealed record TuneRun(
    string Id,
    TuneRunKind Kind,
    TuneRunState State,
    string StartedAt,
    double ElapsedS,
    TunePhase Phase,
    TuneDeltas? Candidate,
    int? Stage,
    TunePattern? Pattern,
    double PatternElapsedS,
    int PatternSeconds,
    int DeviceLostCount,
    int ErrorCount,
    double? BandwidthGBs,
    double? BestBandwidthGBs,
    TuneValidity Validity,
    string LastEvent,
    IReadOnlyList<TuneCandidate> Candidates,
    TuneResult? Result,
    string? Error);

public sealed record TuneNvapi(bool Available, string? Reason, TuneDeltas? Deltas, PstateDeltaRange? Range);

/// <summary>GET /tune/state: the persisted file's fields, the NVAPI read, the run if one is
/// active, and the facts the page needs to explain itself. <see cref="RevertTaskProblem"/>
/// says why the logon task is not registered (the exe's folder is writable by others);
/// <see cref="Problem"/> is what stops Tune altogether (the state file's folder could not
/// be restricted to administrators, the file does not parse, another collector on this
/// machine holds the state).</summary>
public sealed record TuneStatus(
    bool Enabled,
    TuneRollback State,
    TuneDeltas? Baseline,
    TuneDeltas? Candidate,
    string? AppliedAt,
    string? LastCleanShutdown,
    TuneReverted? Reverted,
    TuneResult? Result,
    IReadOnlyList<TuneHistoryEntry> History,
    TuneNvapi Nvapi,
    TuneRun? Run,
    bool RevertTaskRegistered,
    bool FlightAvailable,
    string StateFile)
{
    public string? RevertTaskProblem { get; init; }
    public string? Problem { get; init; }
}

/// <summary>POST /tune/start. <see cref="Enabled"/> is the UI's own setting, checked beside
/// the state file's flag so neither side can start a hunt alone; a client that omits it
/// is held to the file's flag alone. <see cref="Target"/> is the client's other spelling of the kind.</summary>
public sealed record TuneStartRequest(TuneRunKind? Kind, TuneRunKind? Target, bool? Enabled)
{
    public TuneRunKind EffectiveKind => Kind ?? Target ?? TuneRunKind.Core;

    /// <summary>At most this many candidates tried, then the run ends with what it has
    /// (unconverged, low confidence): a bounded smoke test of the ladder on a live card.
    /// Null, the default, is unlimited.</summary>
    public int? MaxCandidates { get; init; }
}

/// <summary>POST /tune/enable. On, the acknowledgement of the warning modal travels with
/// it (plan section 27a: date, app version, and the GPU name the collector adds) and is
/// written to the state file's history and the log.</summary>
public sealed record TuneEnableRequest(bool Enabled, string? AcknowledgedAt, string? AppVersion);

/// <summary>GET /tune/export: the copy-pasteable Afterburner / GPU Tweak value set, with
/// the baseline it was measured from (plan section 16, output).</summary>
public sealed record TuneExport(
    int CoreMhz,
    int MemMhz,
    PstateDeltas Baseline,
    string Text,
    bool Validated,
    TuneConfidence Confidence,
    string MeasuredAt);

/// <summary>The one line /health carries about Tune, so a crash revert is visible from the
/// status pill without opening the page. <see cref="RestoreFailure"/> is set while a run's
/// baseline could not be put back (the driver refused every retry): the candidate is still
/// on the card and the file stays PENDING until a revert succeeds.</summary>
public sealed record TuneHealth(TuneRollback State, TuneReverted? Reverted, bool RunActive, string? RestoreFailure);
