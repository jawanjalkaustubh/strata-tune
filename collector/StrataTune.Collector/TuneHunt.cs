using System.Diagnostics;
using System.Text.Json;
using StrataTune.Shared;

namespace StrataTune.Collector;

/// <summary>A refusal or a failure that ends the run with a sentence for the user; the
/// finally block that puts the baseline back runs whatever the reason.</summary>
internal sealed class TuneAbort(string message) : Exception(message);

/// <summary>One run's mutable record, snapshotted to <see cref="TuneRun"/> under the run's
/// own lock for GET /tune/state and the 2 Hz SSE event. <see cref="ApplyGate"/> serialises
/// the driver writes (apply and restore) without holding up the snapshot while a restore
/// retries.</summary>
internal sealed class TuneRunContext(string id, TuneRunKind kind)
{
    public string Id { get; } = id;
    public TuneRunKind Kind { get; } = kind;
    /// <summary>The request's cap on candidates tried; null is unlimited.</summary>
    public int? MaxCandidates { get; init; }
    public string StartedAt { get; } = DateTimeOffset.UtcNow.ToString("O");
    public long StartedQpc { get; } = Stopwatch.GetTimestamp();
    public CancellationTokenSource Cancel { get; } = new();
    public Lock ApplyGate { get; } = new();
    public TuneRunState State { get; set; } = TuneRunState.Running;
    /// <summary>Set once the finally block has restored and released: the run is over for the supervisor too.</summary>
    public DateTimeOffset? EndedAt { get; set; }
    public TunePhase Phase { get; set; } = TunePhase.Reference;
    public TuneDeltas? Baseline { get; set; }
    public PstateDeltaRange? Range { get; set; }
    public string? Luid { get; set; }
    public string? ReferenceHash { get; set; }
    public uint? ReferenceSmMhz { get; set; }
    public uint? ReferenceMemMhz { get; set; }
    public TuneDeltas? Candidate { get; set; }
    public int? Stage { get; set; }
    public TunePattern? Pattern { get; set; }
    public long PatternStartQpc { get; set; }
    public int PatternSeconds { get; set; }
    public int DeviceLostCount { get; set; }
    public DateTimeOffset LastDeviceLost { get; set; } = DateTimeOffset.MinValue;
    public int ErrorCount { get; set; }
    public double? BandwidthGBs { get; set; }
    public double? BestBandwidthGBs { get; set; }
    /// <summary>The relative spread of the baseline step's stream passes: the memory sweep's noise floor.</summary>
    public double? BaselineSpread { get; set; }
    public TuneValidity Validity { get; set; } = TuneValidity.Unknown;
    public string LastEvent { get; set; } = "";
    public List<TuneCandidate> Candidates { get; } = [];
    public TuneResult? Result { get; set; }
    public string? Error { get; set; }
    /// <summary>Something of ours is on the card, or was: the finally block must restore.</summary>
    public bool Applied { get; set; }
    public bool Restored { get; set; }
    /// <summary>Set while the baseline could not be put back: the file stays PENDING and /health says so.</summary>
    public string? RestoreFailure { get; set; }
    public Process? Worker { get; set; }

    // Under the run's own lock, the one the hunt takes to add a candidate: the 2 Hz snapshot
    // must never copy the list while it grows.
    public TuneRun Snapshot()
    {
        lock (this)
            return new(
                Id, Kind, State, StartedAt, Stopwatch.GetElapsedTime(StartedQpc).TotalSeconds, Phase, Candidate, Stage, Pattern,
                PatternStartQpc == 0 ? 0 : Stopwatch.GetElapsedTime(PatternStartQpc).TotalSeconds, PatternSeconds,
                DeviceLostCount, ErrorCount, BandwidthGBs, BestBandwidthGBs, Validity, LastEvent, Candidates.ToList(), Result, Error);
    }
}

/// <summary>The hunt itself (plan section 16): the supervisor never touches the GPU; it
/// applies a candidate through NVAPI, launches the worker for the three patterns, reads the
/// verdict off exit codes, the heartbeat file and the sensors, and walks the ladder. Every
/// path out re-applies the baseline. Safety rails from dependencies.md: the baseline goes
/// back the moment a device loss is seen (the desktop must not sit on the offset that just
/// hung the driver), 15 s between launches after one, the whole run aborts on the second,
/// and a stalled collector aborts the run because a run nobody is watching is not a test.</summary>
internal sealed class TuneHunt(TuneSupervisor owner, Sources sources, RingBuffer buffer, string workerPath, TuneStateStore store, FlightRecorder recorder, Log log)
{
    private static readonly TimeSpan TickPeriod = TimeSpan.FromMilliseconds(500);
    private static readonly TimeSpan DeviceLostGap = TimeSpan.FromSeconds(15);
    private static readonly TimeSpan HeartbeatStale = TimeSpan.FromSeconds(6);
    // The worker's device creation and shader load come before its first pattern dispatch;
    // the heartbeat's first write is synchronous, but a slow adapter is given this long.
    private static readonly TimeSpan HeartbeatGraceAfterStart = TimeSpan.FromSeconds(8);
    private static readonly TimeSpan ExitGrace = TimeSpan.FromSeconds(20);
    // A killed worker whose GPU context cannot be torn down (a long TDR delay) must not hold
    // the run: the restore runs regardless once this has passed.
    private static readonly TimeSpan KillWait = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan SamplingStall = TimeSpan.FromSeconds(3);
    // A stale heartbeat is called on two consecutive reads: one read may land inside the
    // worker's write, or on a file Defender is scanning.
    private const int StaleReadsToKill = 2;
    private const int MaxDeviceLost = 2;
    // Restore is retried with a growing gap (1+2+3+4+5 s) because it runs at the worst
    // moment, right after a TDR, when the driver may still refuse NVAPI calls.
    private const int RestoreAttempts = 6;
    private static readonly TimeSpan RestoreGateWait = TimeSpan.FromSeconds(3);
    // A sweep step whose three passes disagree by more than this proves nothing about the memory.
    private const double SweepSpreadLimit = 0.10;

    private sealed record WorkerOutcome(int ExitCode, bool HeartbeatStale, bool Drifted, double ThrottledFraction, double? BandwidthGBs, uint MaxSmMhz, uint MaxMemMhz, string Stdout, string Stderr);

    public async Task RunAsync(TuneRunContext run)
    {
        var ct = run.Cancel.Token;
        var end = TuneRunState.Done;
        try
        {
            recorder.Start();
            Event(run, $"{run.Kind} run started");
            var range = NvapiPstates.ReadDeltas(out var failure) ?? throw new TuneAbort($"NVAPI pstates unreadable: {failure}");
            run.Range = range;
            run.Baseline = range.Deltas;
            store.Baseline(range.Deltas, $"baseline read from the card at run start: core {range.Deltas.CoreKhz / 1000} / memory {range.Deltas.MemKhz / 1000} MHz (driver range core {range.CoreMinKhz / 1000}..{range.CoreMaxKhz / 1000}, memory {range.MemMinKhz / 1000}..{range.MemMaxKhz / 1000})");
            if (!range.Editable)
                throw new TuneAbort("the driver reports the P0 clock entries as not editable on this card");

            run.Luid = await FindAdapterAsync(run, ct);
            run.ReferenceHash = await ReferenceAsync(run, ct);
            switch (run.Kind)
            {
                case TuneRunKind.Core:
                    await CoreHuntAsync(run, ct);
                    break;
                case TuneRunKind.Memory:
                    await MemoryHuntAsync(run, ct);
                    break;
                default:
                    await ValidateAsync(run, ct);
                    break;
            }
        }
        catch (OperationCanceledException)
        {
            end = TuneRunState.Stopped;
            run.Error = "stopped by the user";
            Event(run, "stopped by the user");
        }
        catch (TuneAbort e)
        {
            end = TuneRunState.Failed;
            run.Error = e.Message;
            Event(run, $"run ended: {e.Message}");
        }
        catch (Exception e)
        {
            end = TuneRunState.Failed;
            run.Error = $"{e.GetType().Name}: {e.Message}";
            log.Write($"tune run {run.Id}: {e}");
        }
        finally
        {
            // The terminal state is set last: a start that slips in between must still see
            // this run as active while its worker is dying and its baseline going back,
            // else it takes a gpu.lock this run's release then deletes.
            KillWorker(run);
            Restore(run);
            recorder.Stop(keepFile: !run.Restored);
            FamilyGpuLock.Release();
            run.EndedAt = DateTimeOffset.UtcNow;
            run.State = end;
            owner.RunEnded(run);
        }
    }

    /// <summary>Puts the baseline back and writes KNOWN_GOOD, once, from whichever side gets
    /// there first (the run loop's finally or the collector's shutdown). A driver that
    /// refuses every retry leaves the file at PENDING on purpose, the run un-restored so a
    /// later shutdown tries once more, and /health carrying the failure: the next start and
    /// the logon task retry too.</summary>
    public void Restore(TuneRunContext run)
    {
        // Bounded: a shutdown must not wait behind an apply or a restore that is hung
        // inside the driver on another thread; that thread's outcome stands.
        if (!run.ApplyGate.TryEnter(RestoreGateWait))
        {
            log.Write($"tune run {run.Id}: restore skipped: another apply or restore holds the driver");
            return;
        }
        try
        {
            if (run.Restored)
                return;
            run.Phase = TunePhase.Restore;
            if (!run.Applied || run.Baseline is not { } baseline)
            {
                run.Restored = true;
                if (store.Current.State == TuneRollback.Pending)
                    store.KnownGood("run ended with nothing applied");
                return;
            }
            var status = "";
            for (var attempt = 1; attempt <= RestoreAttempts; attempt++)
            {
                if (NvapiPstates.ApplyDeltas(baseline, out status))
                {
                    log.Write($"tune run {run.Id}: restore baseline ok on attempt {attempt}: {status}");
                    run.Restored = true;
                    run.RestoreFailure = null;
                    store.KnownGood($"baseline restored after the run: {status}");
                    return;
                }
                log.Write($"tune run {run.Id}: restore baseline attempt {attempt} FAILED: {status}");
                if (attempt < RestoreAttempts)
                    Thread.Sleep(TimeSpan.FromSeconds(attempt));
            }
            run.RestoreFailure = $"the baseline could NOT be restored after {RestoreAttempts} attempts ({status}): the candidate may still be on the card; the state file stays PENDING so the next start reverts";
            run.Error = $"{run.Error}; {run.RestoreFailure}";
            Event(run, run.RestoreFailure);
        }
        finally
        {
            run.ApplyGate.Exit();
        }
    }

    private async Task CoreHuntAsync(TuneRunContext run, CancellationToken ct)
    {
        var baseline = run.Baseline!;
        var max = run.Range!.CoreMaxKhz;
        var stable = baseline.CoreKhz;
        var stableFound = false;
        int? failing = null;
        var atDriverMax = false;
        run.Phase = TunePhase.Coarse;
        for (var next = TuneLadder.NextCoarse(stable, TuneLadder.CoreStepKhz, max); ; next = TuneLadder.NextCoarse(next.Value, TuneLadder.CoreStepKhz, max))
        {
            if (next is null)
            {
                atDriverMax = true;
                Event(run, $"every rung up to the driver's +{max / 1000} MHz limit held");
                break;
            }
            if (CapReached(run))
                break;
            var candidate = await TestAsync(run, baseline with { CoreKhz = next.Value }, TuneLadder.HuntPatterns, true, null, ct);
            if (candidate.Verdict == TuneVerdict.Stable)
            {
                stable = next.Value;
                stableFound = true;
            }
            else if (candidate.Verdict == TuneVerdict.Invalid)
            {
                // Each rung certifies the floor for the next; one that proves nothing has no
                // rung above it, and on a limit-bound card climbing on would only end in a crash.
                Event(run, $"stopping at +{next.Value / 1000} MHz: a power or thermal limit held the heavy pattern back, so this rung proves nothing and none above it can be certified");
                break;
            }
            else
            {
                failing = next.Value;
                break;
            }
        }
        if (failing is { } first)
        {
            run.Phase = TunePhase.Bisect;
            var upper = first;
            while (TuneLadder.Midpoint(stable, upper, TuneLadder.CoreResolutionKhz) is { } mid && !CapReached(run))
            {
                var candidate = await TestAsync(run, baseline with { CoreKhz = mid }, TuneLadder.HuntPatterns, true, null, ct);
                if (candidate.Verdict == TuneVerdict.Stable)
                {
                    stable = mid;
                    stableFound = true;
                }
                else if (candidate.Verdict == TuneVerdict.Invalid)
                {
                    Event(run, $"bisect stopped at +{mid / 1000} MHz: the rung was throttled, so it proves nothing either way");
                    break;
                }
                else
                {
                    upper = mid;
                }
            }
        }
        Finish(run, baseline with { CoreKhz = stable }, converged: failing is not null || atDriverMax, atDriverMax, stableFound, null);
    }

    // The memory sweep (plan section 16, "memory by bandwidth, not stability"): each step
    // is three stream passes and their median; the baseline step's spread is the noise
    // floor; the climb stops after two steps in a row that fail to raise the figure (one
    // flat step is noise, two is the memory retrying) or at a real trip, and the bisect
    // then finds the last rising point. The core's power-cap bit is not the gate here: a
    // step is invalid when its own three passes disagree.
    private async Task MemoryHuntAsync(TuneRunContext run, CancellationToken ct)
    {
        var baseline = run.Baseline!;
        var max = run.Range!.MemMaxKhz;
        run.Phase = TunePhase.Sweep;
        var first = await TestAsync(run, baseline, TuneLadder.SweepPatterns, false, null, ct);
        if (first.Verdict != TuneVerdict.Stable || first.BandwidthGBs is null)
            throw new TuneAbort($"the baseline memory clock did not pass the sweep's own check ({first.Verdict}, {first.Note})");
        var bestKhz = baseline.MemKhz;
        var best = first.BandwidthGBs.Value;
        run.BestBandwidthGBs = best;
        Event(run, $"sweep noise floor: the baseline's three passes spread {run.BaselineSpread:P1}, so a step must fall more than {TuneLadder.RegressionFloor(run.BaselineSpread):P1} under the best to count as a regression");
        int? failing = null;
        var flat = 0;
        var stableFound = false;
        var atDriverMax = false;
        for (var next = TuneLadder.NextCoarse(bestKhz, TuneLadder.MemStepKhz, max); ; next = TuneLadder.NextCoarse(next.Value, TuneLadder.MemStepKhz, max))
        {
            if (next is null)
            {
                atDriverMax = true;
                Event(run, $"bandwidth still rising at the driver's +{max / 1000} MHz limit");
                break;
            }
            if (CapReached(run))
                break;
            var candidate = await TestAsync(run, baseline with { MemKhz = next.Value }, TuneLadder.SweepPatterns, false, best, ct);
            if (candidate.Verdict == TuneVerdict.Stable && candidate.BandwidthGBs is { } bw && bw > best)
            {
                best = bw;
                bestKhz = next.Value;
                run.BestBandwidthGBs = best;
                stableFound = true;
                flat = 0;
                continue;
            }
            if (candidate.Verdict == TuneVerdict.Invalid)
            {
                Event(run, $"stopping at +{next.Value / 1000} MHz: {candidate.Note}, so this step proves nothing and none above it can be certified");
                break;
            }
            failing ??= next.Value;
            if (candidate.Verdict != TuneVerdict.Stable)
            {
                Event(run, $"+{next.Value / 1000} MHz: {candidate.Verdict}");
                break;
            }
            flat++;
            Event(run, $"+{next.Value / 1000} MHz: bandwidth did not rise ({candidate.BandwidthGBs:F0} vs {best:F0} GB/s), {flat} of {TuneLadder.SweepFlatSteps} flat steps");
            if (flat >= TuneLadder.SweepFlatSteps)
                break;
        }
        if (failing is { } upper)
        {
            run.Phase = TunePhase.Bisect;
            while (TuneLadder.Midpoint(bestKhz, upper, TuneLadder.MemResolutionKhz) is { } mid && !CapReached(run))
            {
                var candidate = await TestAsync(run, baseline with { MemKhz = mid }, TuneLadder.SweepPatterns, false, best, ct);
                if (candidate.Verdict == TuneVerdict.Stable && candidate.BandwidthGBs is { } bw && bw > best)
                {
                    best = bw;
                    bestKhz = mid;
                    run.BestBandwidthGBs = best;
                    stableFound = true;
                }
                else if (candidate.Verdict == TuneVerdict.Invalid)
                {
                    Event(run, $"bisect stopped at +{mid / 1000} MHz: {candidate.Note}");
                    break;
                }
                else
                {
                    upper = mid;
                }
            }
        }
        Finish(run, baseline with { MemKhz = bestKhz }, converged: failing is not null || atDriverMax, atDriverMax, stableFound, best);
    }

    // Validation runs at the user's real fan curve under sustained load, where limits are
    // expected (plan section 16 puts the validity indicator on the ceiling hunt only): a
    // power-limited pass is a pass, and the throttled share is reported on the result.
    private async Task ValidateAsync(TuneRunContext run, CancellationToken ct)
    {
        var result = store.Current.Result ?? throw new TuneAbort("nothing to validate: run a core or memory hunt first");
        if (result.Baseline != run.Baseline)
            throw new TuneAbort($"the result was measured from a different baseline (core {result.Baseline.CoreKhz / 1000} / memory {result.Baseline.MemKhz / 1000} MHz, now {run.Baseline!.CoreKhz / 1000} / {run.Baseline.MemKhz / 1000}); run the hunt again");
        run.Phase = TunePhase.Validate;
        Event(run, "validation: 5 min sustained heavy at your own fan curve (Strata Tune does not control fans), then 2 min of switching");
        var candidate = await TestAsync(run, result.Deltas, TuneLadder.ValidatePatterns, false, null, ct);
        var passed = candidate.Verdict == TuneVerdict.Stable;
        run.Result = result with { Validated = passed, Confidence = passed ? result.Confidence : TuneConfidence.Low, ThrottledFraction = candidate.ThrottledFraction };
        store.Result(run.Result);
        var limited = candidate.ThrottledFraction > TuneLadder.ThrottledFractionLimit ? $", power- or thermal-limited {candidate.ThrottledFraction:P0} of the time (expected at your fan curve; the hash held throughout)" : "";
        Event(run, passed
            ? $"validation passed{limited}: POST /tune/keep puts this result on the card until the next boot; a clean shutdown and a clean boot then promote it"
            : $"validation failed: {candidate.Verdict}{(candidate.Stage is { } s ? $" at stage {s}" : "")}{(candidate.FailedPattern is { } p ? $" under the {p} pattern" : "")}; the result is not kept");
    }

    /// <summary>The request's cap on candidates (a bounded smoke test): reached, the run
    /// ends with what it has and says so; the result is unconverged and low confidence.</summary>
    private bool CapReached(TuneRunContext run)
    {
        if (run.MaxCandidates is not { } max || run.Candidates.Count < max)
            return false;
        Event(run, $"stopping at the requested cap of {max} candidates");
        return true;
    }

    private void Finish(TuneRunContext run, TuneDeltas found, bool converged, bool atDriverMax, bool aboveBaseline, double? bandwidth)
    {
        var anyInvalid = run.Candidates.Any(c => c.Verdict == TuneVerdict.Invalid);
        var confidence = TuneLadder.Confidence(converged, atDriverMax, run.DeviceLostCount, anyInvalid, aboveBaseline);
        run.Result = new TuneResult(run.Kind, found, run.Baseline!, bandwidth, run.ReferenceHash!, confidence, false, DateTimeOffset.UtcNow.ToString("O"))
        {
            ReferenceSmMhz = run.ReferenceSmMhz,
            ReferenceMemMhz = run.ReferenceMemMhz,
        };
        store.Result(run.Result);
        var powerCapped = run.Candidates.Count > 0 && run.Candidates.All(c => c.Verdict == TuneVerdict.Invalid);
        Event(run, aboveBaseline
            ? $"result: core +{found.CoreKhz / 1000} MHz, memory +{found.MemKhz / 1000} MHz ({confidence} confidence)"
            : powerCapped
                ? "no rung could be certified: every candidate hit a power or thermal limit under the heavy pattern; this card is limit-bound, so an undervolt is the lever, not an offset"
                : "nothing above the baseline held; the baseline is the result");
    }

    /// <summary>One candidate through its patterns. The file says PENDING before the driver
    /// hears the value; the patterns run in order and the first that trips ends the
    /// candidate; a candidate that passes them all is judged on the heavy pattern's throttle
    /// share (when gated) and its bandwidth against the best. The candidate is recorded
    /// whatever happens to it, and a device loss puts the baseline back before anything else.</summary>
    private async Task<TuneCandidate> TestAsync(TuneRunContext run, TuneDeltas deltas, (TunePattern Pattern, int Seconds)[] patterns, bool throttleGate, double? bestBandwidth, CancellationToken ct)
    {
        await WaitAfterDeviceLostAsync(run, ct);
        Apply(run, deltas, ct);
        TuneCandidate entry;
        var heavyThrottled = 0.0;
        var passes = new List<double>();
        foreach (var (pattern, seconds) in patterns)
        {
            var outcome = await LaunchPatternAsync(run, pattern, seconds, ct);
            if (pattern == TunePattern.Heavy)
            {
                heavyThrottled = outcome.ThrottledFraction;
                if (outcome.BandwidthGBs is { } bw)
                    passes.Add(bw);
            }
            if (outcome.Drifted)
            {
                entry = new TuneCandidate(deltas, TuneVerdict.Invalid, null, pattern, Bandwidth(passes), heavyThrottled, "invalid: the offset changed under the test (another tool wrote the clock offsets)");
                Record(run, entry);
                return entry;
            }
            var verdict = TuneLadder.PatternVerdict(outcome.ExitCode, outcome.HeartbeatStale)
                ?? throw new TuneAbort($"the worker failed under the {pattern} pattern (exit {outcome.ExitCode}): {Tail(outcome.Stderr)}");
            if (verdict.Verdict == TuneVerdict.DeviceLost)
            {
                CountDeviceLost(run);
                ApplyBaselineNow(run, "device lost");
                run.Stage = 3;
                entry = new TuneCandidate(deltas, TuneVerdict.DeviceLost, 3, pattern, Bandwidth(passes), heavyThrottled,
                    outcome.HeartbeatStale ? "no heartbeat for 6 s on two reads: killed and counted as a TDR" : $"device lost: {Tail(outcome.Stderr)}");
                Record(run, entry);
                if (run.DeviceLostCount >= MaxDeviceLost)
                    throw new TuneAbort("two device-lost events in one run: stopping here (Windows bug-checks on repeated GPU hangs)");
                return entry;
            }
            if (verdict.Verdict == TuneVerdict.Unstable)
            {
                run.ErrorCount++;
                run.Stage = verdict.Stage;
                entry = new TuneCandidate(deltas, TuneVerdict.Unstable, verdict.Stage, pattern, Bandwidth(passes), heavyThrottled, $"hash mismatch: {Tail(outcome.Stderr)}");
                Record(run, entry);
                return entry;
            }
        }
        var bandwidth = Bandwidth(passes);
        var spread = TuneLadder.Spread(passes);
        if (run.Kind == TuneRunKind.Memory && run.BaselineSpread is null)
            run.BaselineSpread = spread;
        var judged = !throttleGate && passes.Count > 1 && spread > SweepSpreadLimit
            ? (Verdict: TuneVerdict.Invalid, Stage: (int?)null)
            : TuneLadder.Judge(heavyThrottled, throttleGate, bandwidth, bestBandwidth, run.BaselineSpread);
        if (judged.Verdict == TuneVerdict.Unstable)
        {
            run.ErrorCount++;
            run.Stage = 2;
        }
        else
        {
            run.Stage = null;
        }
        entry = new TuneCandidate(deltas, judged.Verdict, judged.Stage, judged.Verdict == TuneVerdict.Unstable ? TunePattern.Heavy : null, bandwidth, heavyThrottled, judged.Verdict switch
        {
            TuneVerdict.Unstable => $"bandwidth {bandwidth:F0} GB/s is more than {TuneLadder.RegressionFloor(run.BaselineSpread):P1} under the best {bestBandwidth:F0}",
            TuneVerdict.Invalid => throttleGate
                ? $"a power or thermal limit was set on {heavyThrottled:P0} of the heavy pattern's samples"
                : $"bandwidth inconsistent across three passes ({spread:P1} spread; another GPU user, or the sampler's own load)",
            _ => passes.Count > 1 ? $"every pattern passed; bandwidth {bandwidth:F0} GB/s (median of {passes.Count}, {spread:P1} spread)" : "every pattern passed",
        });
        Record(run, entry);
        return entry;
    }

    private static double? Bandwidth(List<double> passes) => passes.Count == 0 ? null : TuneLadder.Median(passes);

    private void CountDeviceLost(TuneRunContext run)
    {
        run.DeviceLostCount++;
        run.ErrorCount++;
        run.LastDeviceLost = DateTimeOffset.UtcNow;
        store.DeviceLost();
    }

    // Serialised with Restore on the run's apply gate: a shutdown that restored the
    // baseline a moment ago must not be followed by one more apply, and an apply that
    // slips in anyway re-arms the restore. The disk must take PENDING first: a candidate
    // on the card while the file still says KNOWN_GOOD is a hang nobody could attribute.
    private void Apply(TuneRunContext run, TuneDeltas deltas, CancellationToken ct)
    {
        lock (run.ApplyGate)
        {
            ct.ThrowIfCancellationRequested();
            run.Candidate = deltas;
            run.Stage = null;
            run.Pattern = null;
            run.BandwidthGBs = null;
            run.Validity = TuneValidity.Unknown;
            if (!store.Pending(deltas, $"applying core {deltas.CoreKhz / 1000} / memory {deltas.MemKhz / 1000} MHz"))
                throw new TuneAbort($"the state file at {TuneStateStore.FilePath} could not be written, so nothing was applied: a candidate the disk does not know about could never be reverted after a hang");
            run.Applied = true;
            run.Restored = false;
            var ok = NvapiPstates.ApplyDeltas(deltas, out var status);
            log.Write($"tune run {run.Id}: apply {(ok ? "ok" : "FAILED")}: {status}");
            Event(run, ok ? $"applied core +{deltas.CoreKhz / 1000} / memory +{deltas.MemKhz / 1000} MHz" : $"apply failed: {status}");
            if (!ok)
                throw new TuneAbort($"the driver refused the candidate: {status}");
        }
    }

    // The desktop, DWM and the user's other apps must not run on a driver that just
    // recovered from a TDR at the offset that hung it: the baseline goes back at once, and
    // the 15 s gap is waited at safe clocks. A refusal here is left to the finally's retries.
    private void ApplyBaselineNow(TuneRunContext run, string why)
    {
        lock (run.ApplyGate)
        {
            if (!run.Applied || run.Baseline is not { } baseline)
                return;
            var ok = NvapiPstates.ApplyDeltas(baseline, out var status);
            log.Write($"tune run {run.Id}: baseline back after {why} {(ok ? "ok" : "FAILED")}: {status}");
            if (!ok)
                return;
            run.Applied = false;
            store.KnownGood($"baseline back after {why}: {status}");
        }
    }

    private void Record(TuneRunContext run, TuneCandidate candidate)
    {
        lock (run)
            run.Candidates.Add(candidate);
        Event(run, $"core +{candidate.Deltas.CoreKhz / 1000} / memory +{candidate.Deltas.MemKhz / 1000} MHz: {candidate.Verdict}{(candidate.Stage is { } s ? $" (stage {s})" : "")}: {candidate.Note}");
    }

    private async Task WaitAfterDeviceLostAsync(TuneRunContext run, CancellationToken ct)
    {
        var until = run.LastDeviceLost + DeviceLostGap;
        if (DateTimeOffset.UtcNow >= until)
            return;
        Event(run, "waiting 15 s after the device loss, at the baseline, before the next launch");
        while (DateTimeOffset.UtcNow < until)
        {
            Tick(run);
            await Task.Delay(TickPeriod, ct);
        }
    }

    private async Task<string> FindAdapterAsync(TuneRunContext run, CancellationToken ct)
    {
        var outcome = await LaunchAsync(run, ["--devices"], TimeSpan.FromSeconds(30), null, ct);
        if (outcome.ExitCode != 0)
            throw new TuneAbort($"the worker could not list adapters (exit {outcome.ExitCode}): {Tail(outcome.Stderr)}");
        var gpuName = sources.NvmlSampler?.Latest.FirstOrDefault()?.Name;
        string? fallback = null;
        foreach (var line in outcome.Stdout.Split('\n'))
        {
            var parts = line.Split(" | ");
            if (parts.Length < 3 || !parts[2].StartsWith("hardware"))
                continue;
            var luid = parts[1].Replace("luid ", "").Trim();
            if (gpuName is not null && string.Equals(parts[0].Trim(), gpuName, StringComparison.OrdinalIgnoreCase))
                return luid;
            fallback ??= luid;
        }
        return fallback ?? throw new TuneAbort("no DX12 hardware adapter: the worker sees only WARP");
    }

    // The reference also says what the card runs at with nothing of ours applied (the
    // clocks the export quotes) and whether it is limit-bound before any rung is tried.
    private async Task<string> ReferenceAsync(TuneRunContext run, CancellationToken ct)
    {
        run.Phase = TunePhase.Reference;
        Event(run, "capturing the stock-clock reference hash at the baseline");
        var outcome = await LaunchAsync(run, ["--reference", "--json", "--adapter", run.Luid!], TimeSpan.FromSeconds(60), null, ct);
        run.ReferenceSmMhz = outcome.MaxSmMhz;
        run.ReferenceMemMhz = outcome.MaxMemMhz;
        if (outcome.ExitCode == 10 || outcome.HeartbeatStale)
        {
            CountDeviceLost(run);
            throw new TuneAbort("the card lost its device during the reference run, with nothing of ours applied: it is not stable as it is, and no hunt can start from there");
        }
        if (outcome.ExitCode == 2)
            throw new TuneAbort("the card cannot repeat its own reference at the baseline: it is not stable as it is, and no hunt can start from there");
        if (outcome.ExitCode != 0)
            throw new TuneAbort($"the reference run failed (exit {outcome.ExitCode}): {Tail(outcome.Stderr)}");
        var hash = LastJsonLine(outcome.Stdout)?.TryGetProperty("hash", out var h) == true ? h.GetString() : null;
        if (string.IsNullOrEmpty(hash))
            throw new TuneAbort("the reference run printed no hash");
        Event(run, $"reference hash {hash} at core {outcome.MaxSmMhz} / memory {outcome.MaxMemMhz} MHz");
        if (run.Kind != TuneRunKind.Validate && outcome.ThrottledFraction > TuneLadder.ThrottledFractionLimit)
            Event(run, $"the card sat at a power or thermal limit {outcome.ThrottledFraction:P0} of the reference run: an offset has no gain on a limit-bound card (an undervolt is the lever; not in this version), and rungs will read as invalid");
        return hash;
    }

    private Task<WorkerOutcome> LaunchPatternAsync(TuneRunContext run, TunePattern pattern, int seconds, CancellationToken ct)
    {
        run.Pattern = pattern;
        run.PatternSeconds = seconds;
        run.PatternStartQpc = Stopwatch.GetTimestamp();
        run.Stage = 1;
        var name = pattern.ToString().ToLowerInvariant();
        return LaunchAsync(run, ["--ladder", "--pattern", name, "--seconds", seconds.ToString(), "--expect", run.ReferenceHash!, "--adapter", run.Luid!],
            TimeSpan.FromSeconds(seconds) + ExitGrace, pattern, ct);
    }

    /// <summary>Starts the worker beside this exe and watches it at 2 Hz: the flight
    /// recorder samples, the throttle bits are counted under the heavy pattern and the
    /// reference, the peak clocks are kept, a heartbeat older than 6 s on two reads or a
    /// deadline passed kills it and counts as a TDR, an offset that changed under the test
    /// kills it and marks the candidate invalid, and a stalled collector aborts the run.
    /// The worker's last JSON line carries the bandwidth.</summary>
    private async Task<WorkerOutcome> LaunchAsync(TuneRunContext run, string[] args, TimeSpan deadline, TunePattern? pattern, CancellationToken ct)
    {
        var heartbeat = Path.Combine(Path.GetTempPath(), $"strata-tune-tune-{run.Id}-{Guid.NewGuid():N}.heartbeat");
        var info = new ProcessStartInfo(workerPath)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var a in args)
            info.ArgumentList.Add(a);
        var withHeartbeat = args[0] != "--devices";
        if (withHeartbeat)
        {
            info.ArgumentList.Add("--heartbeat");
            info.ArgumentList.Add(heartbeat);
        }
        var countThrottle = pattern == TunePattern.Heavy || args[0] == "--reference";
        log.Write($"tune run {run.Id}: worker {string.Join(' ', args)}");

        var started = DateTimeOffset.UtcNow;
        bool stale = false, drifted = false;
        int throttledTicks = 0, ticks = 0, staleReads = 0;
        uint maxSm = 0, maxMem = 0;
        var lastAge = TimeSpan.Zero;
        try
        {
            using var process = Process.Start(info) ?? throw new TuneAbort("the worker did not start");
            run.Worker = process;
            var stdout = process.StandardOutput.ReadToEndAsync();
            var stderr = process.StandardError.ReadToEndAsync();
            using var timer = new PeriodicTimer(TickPeriod);
            // A stall abort thrown from a tick must not leave the worker loading the card.
            try
            {
                await WatchAsync();
            }
            catch
            {
                KillWorker(run);
                throw;
            }
            // Bounded: a GPU context that cannot be torn down (a long TDR delay) would
            // otherwise hold the run and its restore for as long as the hang lasts.
            await Task.WhenAny(process.WaitForExitAsync(CancellationToken.None), Task.Delay(KillWait));
            if (!process.HasExited)
            {
                Event(run, $"the killed worker did not exit within {KillWait.TotalSeconds:0} s (its GPU context is stuck); going on without it");
                return new WorkerOutcome(10, true, drifted, Fraction(), null, maxSm, maxMem, "", "the worker could not be torn down");
            }
            var outText = await stdout;
            var errText = await stderr;
            ct.ThrowIfCancellationRequested();
            var bandwidth = LastJsonLine(outText) is { } json && json.TryGetProperty("bandwidthGBs", out var bw) && bw.ValueKind == JsonValueKind.Number ? bw.GetDouble() : (double?)null;
            if (bandwidth is { } b)
                run.BandwidthGBs = b;
            var fraction = Fraction();
            log.Write($"tune run {run.Id}: worker exit {process.ExitCode}{(stale ? " (killed)" : "")}{(drifted ? " (offset drifted)" : "")}, bandwidth {bandwidth?.ToString("F1") ?? "-"} GB/s, throttled {fraction:P0}, peak core {maxSm} / memory {maxMem} MHz{(errText.Length > 0 ? $", stderr: {Tail(errText)}" : "")}");
            return new WorkerOutcome(stale ? 10 : process.ExitCode, stale, drifted, fraction, bandwidth, maxSm, maxMem, outText, errText);

            double Fraction() => ticks == 0 ? 0 : throttledTicks / (double)ticks;

            async Task WatchAsync()
            {
                while (!process.HasExited)
                {
                    var facts = Tick(run);
                    if (facts is not null)
                    {
                        maxSm = Math.Max(maxSm, facts.Clocks.SmMhz);
                        maxMem = Math.Max(maxMem, facts.Clocks.MemMhz);
                    }
                    if (countThrottle && facts is not null)
                    {
                        ticks++;
                        if ((facts.ClocksEventReasons.Raw & TuneLadder.ThrottleBits) != 0)
                            throttledTicks++;
                        run.Validity = throttledTicks > ticks * TuneLadder.ThrottledFractionLimit ? TuneValidity.Throttled : TuneValidity.Ok;
                    }
                    var now = DateTimeOffset.UtcNow;
                    if (withHeartbeat && now - started > HeartbeatGraceAfterStart)
                    {
                        lastAge = HeartbeatAge(heartbeat, now) ?? lastAge;
                        staleReads = lastAge > HeartbeatStale ? staleReads + 1 : 0;
                    }
                    if (staleReads >= StaleReadsToKill)
                    {
                        stale = true;
                        Event(run, "worker heartbeat stale for 6 s on two reads: killing it and counting a TDR");
                    }
                    else if (now - started > deadline)
                    {
                        stale = true;
                        Event(run, $"worker did not exit {ExitGrace.TotalSeconds:0} s past its own deadline: killing it and counting a TDR");
                    }
                    else if (pattern is not null && run.Candidate is { } expected && NvapiPstates.Cached() is { } held && (held.CoreMhz != expected.CoreKhz / 1000 || held.MemMhz != expected.MemKhz / 1000))
                    {
                        drifted = true;
                        Event(run, $"the clock offsets changed under the test (driver holds core {held.CoreMhz} / memory {held.MemMhz} MHz, the candidate is {expected.CoreKhz / 1000} / {expected.MemKhz / 1000}): killing the worker; this rung proves nothing");
                    }
                    if (stale || drifted || ct.IsCancellationRequested)
                    {
                        KillWorker(run);
                        break;
                    }
                    await timer.WaitForNextTickAsync(CancellationToken.None);
                }
            }
        }
        finally
        {
            run.Worker = null;
            try
            {
                File.Delete(heartbeat);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
            }
        }
    }

    /// <summary>One 2 Hz tick of the watch: the flight sample and the stall check. Returns
    /// the newest GPU facts for the caller's throttle count.</summary>
    private GpuFacts? Tick(TuneRunContext run)
    {
        var row = buffer.Latest();
        var qpc = Stopwatch.GetTimestamp();
        if (row.Qpc > 0 && Stopwatch.GetElapsedTime(row.Qpc, qpc) > SamplingStall)
            throw new TuneAbort("the collector's own sampling stalled for 3 s: a run nobody can watch is not a test");
        var facts = sources.NvmlSampler?.Latest.FirstOrDefault();
        recorder.Sample(qpc, facts, sources.Lhm?.LatestCpu, row);
        return facts;
    }

    private void Event(TuneRunContext run, string text)
    {
        run.LastEvent = text;
        log.Write($"tune run {run.Id}: {text}");
        recorder.Event(text, run.Candidate, run.Stage, run.Pattern);
    }

    public static void KillWorker(TuneRunContext run)
    {
        try
        {
            run.Worker?.Kill(entireProcessTree: true);
        }
        catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
        }
    }

    // The worker writes "<pid> <utc iso>" every 2 s; the stamp inside is read rather than
    // the mtime, which the directory entry can report late. The file is opened sharing
    // write and delete so a read never collides with the worker's write; a read that still
    // fails (or lands on a half-written file) is null, and the caller keeps its last age
    // rather than calling a live worker dead. A file that is not there at all after the
    // grace period is a worker that never got going.
    private static TimeSpan? HeartbeatAge(string path, DateTimeOffset now)
    {
        try
        {
            if (!File.Exists(path))
                return TimeSpan.MaxValue;
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var reader = new StreamReader(stream);
            var parts = reader.ReadToEnd().Split(' ', 2);
            return parts.Length == 2 && DateTimeOffset.TryParse(parts[1].Trim(), null, System.Globalization.DateTimeStyles.AssumeUniversal, out var stamp)
                ? now - stamp
                : null;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    private static JsonElement? LastJsonLine(string stdout)
    {
        foreach (var line in stdout.Split('\n').Reverse())
        {
            var text = line.Trim();
            if (!text.StartsWith('{'))
                continue;
            try
            {
                return JsonDocument.Parse(text).RootElement.Clone();
            }
            catch (JsonException)
            {
                return null;
            }
        }
        return null;
    }

    private static string Tail(string text)
    {
        var trimmed = text.Trim();
        return trimmed.Length <= 300 ? trimmed : trimmed[^300..];
    }
}
