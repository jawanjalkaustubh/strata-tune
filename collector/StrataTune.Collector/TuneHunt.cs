using System.Diagnostics;
using System.Text.Json;
using StrataTune.Shared;

namespace StrataTune.Collector;

/// <summary>A refusal or a failure that ends the run with a sentence for the user; the
/// finally block that puts the baseline back runs whatever the reason.</summary>
internal sealed class TuneAbort(string message) : Exception(message);

/// <summary>The clocks a ladder climbs from (see TuneRunContext.ClimbFrom): the sustained peaks, the top of the curve, and which measurement they are;
/// the sustained mean SM clock and throughput are the core ladder's second and third additivity signals on a power-capped card (plan section 16).</summary>
internal sealed record ClimbFrom(HeldClocks Held, uint? Top, string Source)
{
    public double? MeanSm { get; init; }
    public double? Throughput { get; init; }
}

/// <summary>One run's mutable record, snapshotted to <see cref="TuneRun"/> under the run's
/// own lock for GET /tune/state and the 2 Hz SSE event. <see cref="ApplyGate"/> serialises
/// the driver writes (apply and restore) without holding up the snapshot while a restore
/// retries.</summary>
internal sealed class TuneRunContext(string id, TuneRunKind kind)
{
    public string Id { get; } = id;
    public TuneRunKind Kind { get; } = kind;
    /// <summary>The request's cap on rungs per ladder; null is unlimited.</summary>
    public int? MaxCandidates { get; init; }
    /// <summary>The user's "never test above" clocks (plan section 16); null is no cap.</summary>
    public int? CoreCapMhz { get; init; }
    public int? MemCapMhz { get; init; }
    public string StartedAt { get; } = DateTimeOffset.UtcNow.ToString("O");
    public long StartedQpc { get; } = Stopwatch.GetTimestamp();
    public CancellationTokenSource Cancel { get; } = new();
    public Lock ApplyGate { get; } = new();
    public TuneRunState State { get; set; } = TuneRunState.Running;
    /// <summary>Set once the finally block has restored and released: the run is over for the supervisor too.</summary>
    public DateTimeOffset? EndedAt { get; set; }
    public TunePhase Phase { get; set; } = TunePhase.Reference;
    public TuneLadderKind? Ladder { get; set; }
    /// <summary>Rungs tried in the current ladder, the baseline rung not counted, for the request's cap.</summary>
    public int Rungs { get; set; }
    /// <summary>The P0 deltas as read at the start: what the driver reports as ours.</summary>
    public TuneDeltas? Found { get; set; }
    /// <summary>The revert target and the offsets the rungs climb from: <see cref="Found"/>, or
    /// the user's vendor tune written through our route once one is found on the card.</summary>
    public TuneDeltas? Baseline { get; set; }
    /// <summary>What the user's vendor tool shows, from the request (slider units); null when not given.</summary>
    public PstateDeltas? VendorSlider { get; init; }
    /// <summary>Set once the vendor value entered is the baseline: found on the card and reproduced through our route, or already held by it.</summary>
    public PstateDeltas? Vendor { get; set; }
    /// <summary>The as-found scored run: the card before anything was written.</summary>
    public ScoredRun? AsFound { get; set; }
    /// <summary>The official scored run of the certified pair.</summary>
    public ScoredRun? Official { get; set; }
    /// <summary>What the card held under a short sustained load after the restore.</summary>
    public HeldClocks? HoldsNow { get; set; }
    /// <summary>Which repeat of the shape a scored run is on; 0 outside one.</summary>
    public int Repeat { get; set; }
    /// <summary>The top of the curve as found (the variable half's peak SM clock).</summary>
    public uint? BaselineTop { get; set; }
    /// <summary>
    /// What the ladders climb from and check additivity against: the card as found, or, once
    /// a vendor rung has written the user's tune through our route, that rung's own peaks, the
    /// clocks every rung literally sits on. The two routes sit a boost bin apart (run
    /// 154463d9b2f1 on the dev box: 3337 MHz at the top of the curve as found, 3322 through
    /// P0 +319, the card warmer by then), and a first +15 rung judged against the as-found
    /// figure failed the additivity check for the wrong reason.
    /// </summary>
    public ClimbFrom? ClimbFrom { get; set; }
    public PstateDeltaRange? Range { get; set; }
    public string? Luid { get; set; }
    public string? ReferenceHash { get; set; }
    /// <summary>The card as found: the sustained halves' peak clocks of the as-found scored run.</summary>
    public HeldClocks? BaselineHeld { get; set; }
    public TuneDeltas? Candidate { get; set; }
    public int? Stage { get; set; }
    public TunePattern? Pattern { get; set; }
    public long PatternStartQpc { get; set; }
    public int PatternSeconds { get; set; }
    public int DeviceLostCount { get; set; }
    public DateTimeOffset LastDeviceLost { get; set; } = DateTimeOffset.MinValue;
    public int ErrorCount { get; set; }
    public double? BandwidthGBs { get; set; }
    /// <summary>The best figures of the certified rungs so far, what a rung must not fall under (stage 2).</summary>
    public double? BestBandwidthGBs { get; set; }
    public double? BestThroughputGsps { get; set; }
    /// <summary>The relative spread of the memory baseline rung's passes: the ladder's noise floor.</summary>
    public double? BaselineSpread { get; set; }
    /// <summary>The as-found repeats' spread of sustained throughput (relative) and of the sustained mean SM clock (MHz): the core ladder's noise floors on the cap.</summary>
    public double? BaselineThroughputSpread { get; set; }
    public double? BaselineMeanSmSpreadMhz { get; set; }
    public TuneValidity Validity { get; set; } = TuneValidity.Unknown;
    public string LastEvent { get; set; } = "";
    public List<TuneCandidate> Candidates { get; } = [];
    /// <summary>The highest certified rung of each ladder (the baseline rung when nothing above it held).</summary>
    public TuneCandidate? CoreCertified { get; set; }
    public TuneCandidate? MemoryCertified { get; set; }
    public List<TuneLadderStop> Stops { get; } = [];
    public TuneResult? Result { get; set; }
    public string? Error { get; set; }
    /// <summary>Something of ours is on the card, or was: the finally block must restore.</summary>
    public bool Applied { get; set; }
    /// <summary>The driver has heard a write from this run: the end-of-run truth is worth measuring.</summary>
    public bool Wrote { get; set; }
    public bool Restored { get; set; }
    /// <summary>Set while the baseline could not be put back: the file stays PENDING and /health says so.</summary>
    public string? RestoreFailure { get; set; }
    public Process? Worker { get; set; }

    // Under the run's own lock, the one the hunt takes to add a rung: the 2 Hz snapshot
    // must never copy the list while it grows.
    public TuneRun Snapshot()
    {
        lock (this)
            return new(
                Id, Kind, State, StartedAt, Stopwatch.GetElapsedTime(StartedQpc).TotalSeconds, Phase, Ladder, Candidate, Stage, Pattern,
                PatternStartQpc == 0 ? 0 : Stopwatch.GetElapsedTime(PatternStartQpc).TotalSeconds, PatternSeconds,
                DeviceLostCount, ErrorCount, BandwidthGBs, BestBandwidthGBs, BaselineHeld, Validity, LastEvent, Candidates.ToList(), Result, Error)
            {
                Repeat = Repeat,
                AsFound = AsFound,
            };
    }
}

/// <summary>The hunt itself (plan section 16, as of 2026-09-16): the supervisor never
/// touches the GPU; it scores the card as found over two minutes with nothing written,
/// decides what the baseline is (the driver's own P0 deltas, or the user's vendor tune
/// written through our route because a P0 write replaces it), applies a rung through
/// NVAPI on top, launches the worker for the rung's two halves, reads the verdict off exit
/// codes, the heartbeat file and the sensors, walks each ladder up in small rungs until the
/// first stage trips, bisects, scores the certified pair over two minutes, and after the
/// restore measures what the card holds. The product is a value set and a score; every
/// path out re-applies the baseline (the vendor tune, never 0, when one was found), so the
/// card is left as it was found. Safety rails from dependencies.md: the
/// baseline goes back the moment a device loss is seen (the desktop must not sit on the
/// offset that just hung the driver), 15 s between launches after one, the whole run
/// aborts on the second, and a stalled collector aborts the run because a run nobody is
/// watching is not a test.</summary>
internal sealed class TuneHunt(TuneSupervisor owner, Sources sources, RingBuffer buffer, string workerPath, TuneStateStore store, FlightRecorder recorder, Log log)
{
    // The clocks are read at NVML's own 10 Hz, so the peak under a pattern is the top the
    // card reached and not one sample in five; the flight recorder, the stall check and
    // the heartbeat keep their 2 Hz.
    private static readonly TimeSpan ClockPeriod = TimeSpan.FromMilliseconds(100);
    private const int TicksPerSample = 5;
    private static readonly TimeSpan TickPeriod = ClockPeriod * TicksPerSample;
    // The peaks and the limit-bit shares are read from the steady window only (plan section 8:
    // t >= 3 s): a P0 delta written while the card is busy takes effect at its next P-state
    // change, so the first samples of a pattern can still show the previous rung's clock
    // (measured on the dev box: +60 memory stayed on for a second after the 0 / 0 write).
    private static readonly TimeSpan SettleAfterStart = TimeSpan.FromSeconds(3);
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

    /// <summary>What one worker launch came to: the exit and the watch's verdicts, the JSON line's figures, the settled window's peak and mean SM clocks and the peak memory clock.</summary>
    private sealed record WorkerOutcome(int ExitCode, bool HeartbeatStale, bool Drifted, double ThrottledFraction, double ThermalFraction, double? BandwidthGBs, double? ThroughputGsps, uint MaxSmMhz, uint MaxMemMhz, string Stdout, string Stderr)
    {
        public double? MeanSmMhz { get; init; }
    }

    public async Task RunAsync(TuneRunContext run)
    {
        var ct = run.Cancel.Token;
        var end = TuneRunState.Done;
        // Plan section 17c: a 16-minute hunt must not be cut by the sleep timer; the display is never held.
        KeepAwake.Hold($"tune run {run.Id}");
        try
        {
            recorder.Start();
            Event(run, $"{run.Kind} run started");
            // A read, never a write: the card is measured exactly as found (plan section 16, rule 3).
            var range = NvapiPstates.ReadDeltas(out var failure) ?? throw new TuneAbort($"NVAPI pstates unreadable: {failure}");
            run.Range = range;
            run.Found = range.Deltas;
            run.Baseline = range.Deltas;
            store.Baseline(range.Deltas, null, $"baseline read from the card at run start: P0 offsets core {range.Deltas.CoreMhz} / memory {range.Deltas.MemMhz} MHz, the revert target (driver range core {range.CoreMinKhz / 1000}..{range.CoreMaxKhz / 1000}, memory {range.MemMinKhz / 1000}..{range.MemMaxKhz / 1000})");
            if (!range.Editable)
                throw new TuneAbort("the driver reports the P0 clock entries as not editable on this card");

            run.Luid = await FindAdapterAsync(run, ct);
            run.ReferenceHash = await ReferenceAsync(run, ct);
            await AsFoundAsync(run, ct);
            // A tune we cannot read ends the run here as a result, not a failure: the as-found
            // score is what we can test (user, 2026-09-17: "test what is visible to us and explain").
            if (await DecideBaselineAsync(run, ct))
            {
                // Memory first and on its own: a cheap win, orthogonal to the power cap; the
                // core ladder then starts from the baseline again, one variable at a time.
                if (run.Kind is TuneRunKind.Hunt or TuneRunKind.Memory)
                    await LadderAsync(run, TuneLadderKind.Memory, ct);
                if (run.Kind is TuneRunKind.Hunt or TuneRunKind.Core)
                    await LadderAsync(run, TuneLadderKind.Core, ct);
                await OfficialAsync(run, ct);
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
            await HoldsNowAsync(run, end);
            recorder.Stop(keepFile: !run.Restored);
            FamilyGpuLock.Release();
            KeepAwake.Release($"tune run {run.Id}");
            run.EndedAt = DateTimeOffset.UtcNow;
            run.State = end;
            owner.RunEnded(run);
        }
    }

    /// <summary>Puts the baseline back and writes IDLE, once, from whichever side gets
    /// there first (the run loop's finally or the collector's shutdown). A driver that
    /// refuses every retry leaves the file at PENDING on purpose, the run un-restored so a
    /// later shutdown tries once more, and /health carrying the failure: the next start
    /// reverts it.</summary>
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
                    store.Idle("run ended with nothing applied");
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
                    store.Idle(run.Vendor is { } v
                        ? $"your tune put back through the driver's P0 offsets: core +{baseline.CoreMhz} / memory +{baseline.MemMhz} MHz (the tool shows core +{v.CoreMhz} / memory +{v.MemMhz}), never 0 ({status})"
                        : $"card left as found: P0 offsets back at core {baseline.CoreMhz} / memory {baseline.MemMhz} MHz ({status})");
                    return;
                }
                log.Write($"tune run {run.Id}: restore baseline attempt {attempt} FAILED: {status}");
                if (attempt < RestoreAttempts)
                    Thread.Sleep(TimeSpan.FromSeconds(attempt));
            }
            run.RestoreFailure = $"the baseline could NOT be restored after {RestoreAttempts} attempts ({status}): the rung may still be on the card; the state file stays PENDING so the next start reverts";
            run.Error = $"{run.Error}; {run.RestoreFailure}";
            Event(run, run.RestoreFailure);
        }
        finally
        {
            run.ApplyGate.Exit();
        }
    }

    /// <summary>The as-found scored run (plan section 16: 'the as-found card is scored the same
    /// way first'): two repeats of the 60 s shape with nothing written, the card exactly as the
    /// user runs it, a vendor tool's tune included. Its sustained peaks are the baseline held
    /// clocks, its variable peak the top of the curve, its throughput and bandwidth the floor
    /// every rung is judged against, and its score is what the official run is compared with.</summary>
    private async Task AsFoundAsync(TuneRunContext run, CancellationToken ct)
    {
        run.Phase = TunePhase.AsFound;
        Event(run, $"scoring the card as found: {TuneLadder.ScoredRepeats} repeats of the {TuneLadder.RungShape.Sum(p => p.Seconds)} s shape, nothing written");
        var (asFound, _) = await ScoredAsync(run, run.Baseline!, RungKind.AsFound, ct);
        run.AsFound = asFound;
        if (asFound.Verdict != TuneVerdict.Stable || asFound.Held is null || asFound.Score is null)
            throw new TuneAbort($"the card did not pass its own check as found, with nothing of ours on top ({asFound.Verdict}: {asFound.Note}); no hunt can start from there");
        run.BaselineHeld = asFound.Held;
        run.BaselineTop = asFound.TopSmMhz;
        run.ClimbFrom = new(asFound.Held, asFound.TopSmMhz, "as found") { MeanSm = asFound.MeanSmMhz, Throughput = asFound.Score.ThroughputGsps };
        run.BestThroughputGsps = asFound.Score.ThroughputGsps;
        run.BestBandwidthGBs = asFound.Score.BandwidthGBs;
        Event(run, $"as found: {asFound.Score.Points} points ({asFound.Score.ComputePoints} compute + {asFound.Score.BandwidthPoints} bandwidth; {TuneScoring.PercentOver(asFound.Score.Points, TuneScoring.ReferencePoints):+0.0;-0.0} % against an estimated reference 5090's {TuneScoring.ReferencePoints}); holds {asFound.Held.SmMhz} / {asFound.Held.MemMhz} MHz sustained ({asFound.MeanSmMhz:F0} MHz mean), {asFound.TopSmMhz} MHz at the top of the curve; {asFound.Score.ThroughputGsps:F2} Gsteps/s, {asFound.Score.BandwidthGBs:F0} GB/s, repeats spread {run.BaselineSpread:P1} so a memory rung must fall more than {TuneLadder.RegressionFloor(run.BaselineSpread):P1} under the best to count as a regression; on the cap a core rung counts as added when its sustained mean rises more than {TuneLadder.MeanClockNoiseMhz(run.BaselineMeanSmSpreadMhz):F0} MHz or its throughput more than {TuneLadder.ThroughputNoise(run.BaselineThroughputSpread):P1}");
    }

    /// <summary>The decision before the first write (plan section 16, rules 1–3, in
    /// TuneLadder.PlanVendor): a vendor tool's tune on the card is refused without its value,
    /// checked against the card with it, and then written through our route as the vendor
    /// rung, which becomes the baseline every rung sits on and every restore puts back.</summary>
    /// <returns>False when the run ends at the as-found score: a tune another tool holds, which our offsets would replace.</returns>
    private async Task<bool> DecideBaselineAsync(TuneRunContext run, CancellationToken ct)
    {
        var facts = sources.NvmlSampler?.Latest.FirstOrDefault()?.ClockOffsets;
        var plan = TuneLadder.PlanVendor(run.BaselineHeld!, run.BaselineTop, facts?.MaxClockSmMhz, facts?.MaxClockMemMhz, run.Found!, run.VendorSlider);
        if (plan.Refusal is { } refusal)
        {
            lock (run)
            {
                if (run.Kind is TuneRunKind.Hunt or TuneRunKind.Memory) run.Stops.Add(new(TuneLadderKind.Memory, refusal, 0, null, plan.Sentence!));
                if (run.Kind is TuneRunKind.Hunt or TuneRunKind.Core) run.Stops.Add(new(TuneLadderKind.Core, refusal, 0, null, plan.Sentence!));
            }
            Finish(run);
            if (refusal == TuneStopReason.ForeignTune)
            {
                Event(run, plan.Sentence!);
                return false;
            }
            throw new TuneAbort(plan.Sentence!);
        }
        run.Vendor = plan.Vendor;
        if (plan.Vendor is { } v && !plan.VendorRung)
        {
            store.Baseline(run.Found!, v, $"the driver already holds your tune through our route: P0 core +{run.Found!.CoreMhz} / memory +{run.Found.MemMhz} MHz (the tool shows core +{v.CoreMhz} / memory +{v.MemMhz}); it is the baseline every restore puts back");
            Event(run, $"the driver already holds your tune through our route (P0 core +{run.Found!.CoreMhz} / memory +{run.Found.MemMhz} MHz, the tool shows core +{v.CoreMhz} / memory +{v.MemMhz}): it is the baseline");
        }
        if (!plan.VendorRung)
            return true;
        run.Phase = TunePhase.Vendor;
        var deltas = plan.Baseline;
        var slider = plan.Vendor!;
        run.Baseline = deltas;
        store.Baseline(deltas, slider, $"the baseline is your vendor tune written through our route: P0 core +{deltas.CoreMhz} / memory +{deltas.MemMhz} MHz (the tool shows core +{slider.CoreMhz} / memory +{slider.MemMhz}); it is what every restore puts back, never 0");
        Event(run, $"a vendor tool's tune is on the card ({TuneLadder.CrossCheckLine(run.BaselineHeld!.MemMhz, facts?.MaxClockMemMhz, deltas.MemMhz)}); writing it through the driver's P0 offsets, core +{deltas.CoreMhz} / memory +{deltas.MemMhz} MHz, and measuring it");
        var (vendor, _) = await RungAsync(run, TuneLadderKind.Memory, deltas, RungKind.Vendor, ct);
        if (vendor.Verdict != TuneVerdict.Stable || vendor.Held is null)
            throw new TuneAbort($"your tune, written through the driver's P0 offsets (core +{deltas.CoreMhz} / memory +{deltas.MemMhz} MHz), did not pass the rung's own check ({vendor.Verdict}: {vendor.Note}); the card is back at those offsets, check them in the vendor tool");
        if (!TuneLadder.VendorReproduced(run.BaselineHeld!, vendor.Held))
            throw new TuneAbort($"your tune written through the driver's P0 offsets holds {vendor.Held.SmMhz} / {vendor.Held.MemMhz} MHz where the card as found held {run.BaselineHeld!.SmMhz} / {run.BaselineHeld.MemMhz}: the value entered does not reproduce it; the card is left at those offsets, re-apply your tune in the vendor tool and check what it shows");
        run.ClimbFrom = new(vendor.Held, vendor.TopSmMhz ?? run.BaselineTop, "your tune through our route") { MeanSm = vendor.MeanSmMhz ?? run.ClimbFrom?.MeanSm, Throughput = vendor.ThroughputGsps ?? run.ClimbFrom?.Throughput };
        Event(run, $"your tune reproduced: the card holds {vendor.Held.SmMhz} / {vendor.Held.MemMhz} MHz through our route ({run.ClimbFrom.Top} MHz at the top of the curve) against {run.BaselineHeld!.SmMhz} / {run.BaselineHeld.MemMhz} as found; the ladders climb from these");
        return true;
    }

    /// <summary>One ladder: the climb goes up one rung (a minute) at a time on top of the
    /// baseline and stops at the first rung that fails a stage, the cooler, the driver's
    /// range or clock ceiling, or the request's cap; the bisect then narrows the gap to the
    /// fine step. The first rung doubles as the additivity check, and every rung's held
    /// clock is checked against where the baseline plus our offset puts it, which is how a
    /// tool re-applying its profile mid-run is caught.</summary>
    private async Task LadderAsync(TuneRunContext run, TuneLadderKind ladder, CancellationToken ct)
    {
        var step = TuneLadder.StepKhz(ladder);
        var max = ladder == TuneLadderKind.Core ? run.Range!.CoreMaxKhz : run.Range!.MemMaxKhz;
        run.Ladder = ladder;
        run.Rungs = 0;
        // The previous ladder's last rung comes off (back to the baseline) before this one climbs.
        ApplyBaselineNow(run, $"the {ladder} ladder starts");
        var baseline = run.Baseline!;
        var baselineKhz = Offset(baseline, ladder);
        var baselineHeld = ladder == TuneLadderKind.Core ? run.ClimbFrom?.Top : run.ClimbFrom?.Held.MemMhz;
        if (baselineHeld is not { } baselineFigure)
            throw new TuneAbort($"the as-found run recorded no {(ladder == TuneLadderKind.Core ? "top-of-curve" : "memory")} clock for the {ladder} ladder to climb from");
        var source = run.ClimbFrom!.Source;
        var cap = ladder == TuneLadderKind.Core ? run.CoreCapMhz : run.MemCapMhz;
        TuneLadderStop? stop = null;
        var stableKhz = baselineKhz;
        int? failingKhz = null;
        // The additivity check stays open until a rung decides it (TuneLadder.JudgeAdditivity).
        var additivityOpen = true;
        // The last certified rung of this ladder: the core's movement guard and its top-of-table check compare against it.
        TuneCandidate? previous = null;
        // A tune whose top of the curve already sits at the driver's ceiling leaves a core
        // offset nowhere to show: the first rung would fail the additivity check for the
        // wrong reason, so the ladder ends here and says which limit it is.
        if (ladder == TuneLadderKind.Core && TuneLadder.AtCeiling(baselineFigure, Ceiling(baseline.CoreMhz)))
            stop = new(ladder, TuneStopReason.Ceiling, 0, null, $"the top of the curve is already at the driver's {Ceiling(baseline.CoreMhz)} MHz clock ceiling ({baselineFigure} MHz {source}); a core offset cannot show on this card until the tune below it is lowered");
        run.Phase = TunePhase.Climb;
        Event(run, $"{ladder} ladder: climbing from {baselineFigure} MHz {(ladder == TuneLadderKind.Core ? "at the top of the curve" : "memory")} {source} in +{step / 1000} MHz rungs of a minute each");
        for (var next = TuneLadder.NextRung(stableKhz, step, max); stop is null; next = TuneLadder.NextRung(next.Value, step, max))
        {
            if (next is null)
            {
                stop = new(ladder, TuneStopReason.DriverMax, (stableKhz - baselineKhz) / 1000, null, $"every {ladder} rung up to the driver's +{(max - baselineKhz) / 1000} MHz limit held");
                break;
            }
            if (CapReached(run))
            {
                stop = new(ladder, TuneStopReason.Cap, (stableKhz - baselineKhz) / 1000, null, $"{ladder} ladder stopped at the requested cap of {run.MaxCandidates} rungs");
                break;
            }
            var offsetMhz = (next.Value - baselineKhz) / 1000;
            if (TuneLadder.CapExceeded(baselineFigure, offsetMhz, cap))
            {
                stop = new(ladder, TuneStopReason.UserCap, (stableKhz - baselineKhz) / 1000, null, $"stopped at your cap: the next {ladder} rung, +{offsetMhz} MHz, would put the {(ladder == TuneLadderKind.Core ? "top of the curve" : "memory clock")} at about {baselineFigure + offsetMhz} MHz, above the {cap} MHz you set; nothing above +{(stableKhz - baselineKhz) / 1000} was written");
                break;
            }
            var (candidate, reason) = await RungAsync(run, ladder, With(baseline, ladder, next.Value), RungKind.Climb, ct);
            if (reason == TuneStopReason.Bandwidth)
                (candidate, reason) = await ReconsiderBandwidthAsync(run, candidate, ct);
            var (ended, decided) = CheckHeld(run, ladder, candidate, previous, baselineFigure, source, offsetMhz, additivityOpen, climbing: true);
            if (decided)
                additivityOpen = false;
            if (ended is not null)
            {
                stop = ended;
                break;
            }
            if (candidate.Verdict == TuneVerdict.Stable)
            {
                stableKhz = next.Value;
                Certify(run, ladder, candidate);
                previous = candidate;
                if (ladder == TuneLadderKind.Core && candidate.TopSmMhz is { } top && TuneLadder.AtCeiling(top, Ceiling(candidate.Deltas.CoreMhz)))
                {
                    stop = new(ladder, TuneStopReason.Ceiling, offsetMhz, null, $"the top of the curve reached the driver's {Ceiling(candidate.Deltas.CoreMhz)} MHz clock ceiling at +{offsetMhz} MHz core; no rung above can show");
                    break;
                }
                continue;
            }
            stop = new(ladder, reason!.Value, offsetMhz, TuneLadder.Stage(reason.Value), $"+{offsetMhz} MHz {ladder}: {candidate.Note}");
            if (TuneLadder.IsFailure(reason.Value))
                failingKhz = next.Value;
            break;
        }
        if (failingKhz is { } upper)
        {
            run.Phase = TunePhase.Bisect;
            while (TuneLadder.Midpoint(stableKhz, upper, TuneLadder.ResolutionKhz(ladder)) is { } mid && !CapReached(run))
            {
                var offsetMhz = (mid - baselineKhz) / 1000;
                var (candidate, reason) = await RungAsync(run, ladder, With(baseline, ladder, mid), RungKind.Climb, ct);
                if (reason == TuneStopReason.Bandwidth)
                    (candidate, reason) = await ReconsiderBandwidthAsync(run, candidate, ct);
                CheckHeld(run, ladder, candidate, previous, baselineFigure, source, offsetMhz, additivityOpen: false, climbing: false);
                if (candidate.Verdict == TuneVerdict.Stable)
                {
                    stableKhz = mid;
                    Certify(run, ladder, candidate);
                    previous = candidate;
                    continue;
                }
                if (!TuneLadder.IsFailure(reason!.Value))
                {
                    Event(run, $"bisect stopped at +{offsetMhz} MHz: {candidate.Note}");
                    break;
                }
                // The first failure is the lowest rung that failed, which the bisect keeps lowering.
                stop = new(ladder, reason.Value, offsetMhz, TuneLadder.Stage(reason.Value), $"+{offsetMhz} MHz {ladder}: {candidate.Note}");
                upper = mid;
            }
        }
        if (additivityOpen && stableKhz > baselineKhz)
            Event(run, $"{ladder} additivity undecided: the ladder ended at +{(stableKhz - baselineKhz) / 1000} MHz before a second rung could show whether the driver adds our offset (the first rung read within a bin of the baseline)");
        lock (run)
            run.Stops.Add(stop!);
        // From the certified rung itself, not the climb's last stable value: an additivity or top-of-table stop drops the rung it had certified.
        var certifiedKhz = (ladder == TuneLadderKind.Core ? run.CoreCertified?.Deltas.CoreKhz : run.MemoryCertified?.Deltas.MemKhz) ?? baselineKhz;
        Event(run, $"{ladder} ladder ended: {stop!.Note}; certified +{(certifiedKhz - baselineKhz) / 1000} MHz on top of the baseline");
        Finish(run);
        // A driver that does not add our offset is the plan's refusal state: the run ends on
        // that sentence, with the result recording the ladder that hit it.
        if (TuneLadder.IsRefusal(stop.Reason))
            throw new TuneAbort(stop.Note);
    }

    /// <summary>The highest certified rung of a ladder so far; null while nothing above the baseline held, and null again
    /// when the ladder's additivity check fails after a rung was certified (a rung the driver never added certifies nothing).</summary>
    private static void Certify(TuneRunContext run, TuneLadderKind ladder, TuneCandidate? candidate)
    {
        if (ladder == TuneLadderKind.Core)
            run.CoreCertified = candidate;
        else
            run.MemoryCertified = candidate;
    }

    /// <summary>The official run (plan section 16: 'the certified pair then gets the 2-minute
    /// scored run … the official number'): the memory and core certified rungs together over
    /// two repeats of the shape. A failure steps the failing ladder down one fine step and
    /// re-runs once; a second failure leaves the pair uncertified and says so. The result is
    /// written after it either way.</summary>
    private async Task OfficialAsync(TuneRunContext run, CancellationToken ct)
    {
        var baseline = run.Baseline!;
        var pair = new TuneDeltas(run.CoreCertified?.Deltas.CoreKhz ?? baseline.CoreKhz, run.MemoryCertified?.Deltas.MemKhz ?? baseline.MemKhz);
        if (pair == baseline)
        {
            Event(run, "nothing above the baseline was certified: the as-found score stands as the official one, no second scored run");
            Finish(run);
            return;
        }
        run.Phase = TunePhase.Official;
        run.Ladder = null;
        var steppedDown = false;
        for (var attempt = 1; attempt <= 2; attempt++)
        {
            Event(run, $"official run {attempt}: the certified pair, core +{pair.CoreMhz - baseline.CoreMhz} / memory +{pair.MemMhz - baseline.MemMhz} MHz on top, {TuneLadder.ScoredRepeats} repeats of the shape{(steppedDown ? " (one fine step down after a failure)" : "")}");
            var (official, stop) = await ScoredAsync(run, pair, RungKind.Official, ct);
            official = official with { SteppedDown = steppedDown };
            if (official.Verdict == TuneVerdict.Stable && official.Score is { } score)
            {
                run.Official = official;
                if (run.CoreCertified is { } c)
                    run.CoreCertified = c with { Deltas = c.Deltas with { CoreKhz = pair.CoreKhz }, Held = official.Held ?? c.Held };
                if (run.MemoryCertified is { } m)
                    run.MemoryCertified = m with { Deltas = m.Deltas with { MemKhz = pair.MemKhz }, Held = official.Held ?? m.Held };
                Finish(run);
                var asFound = run.AsFound!.Score!.Points;
                Event(run, $"official: {score.Points} points at +{pair.CoreMhz - baseline.CoreMhz} / +{pair.MemMhz - baseline.MemMhz}: {TuneScoring.PercentOver(score.Points, asFound):+0.0;-0.0} % over your current tune's {asFound}, {TuneScoring.PercentOver(score.Points, TuneScoring.ReferencePoints):+0.0;-0.0} % over an estimated reference 5090");
                return;
            }
            run.Official = official;
            if (attempt == 2 || official.Verdict == TuneVerdict.Invalid)
                break;
            var ladders = TuneLadder.FailingLadders(stop ?? TuneStopReason.Hash);
            var lower = TuneLadder.StepDown(pair, baseline, ladders);
            Event(run, $"the official run failed ({official.Note}): stepping the {string.Join(" and ", ladders.Select(l => l.ToString().ToLowerInvariant()))} ladder down one fine step to core +{lower.CoreMhz - baseline.CoreMhz} / memory +{lower.MemMhz - baseline.MemMhz} and re-running once");
            pair = lower;
            steppedDown = true;
        }
        // Uncertified: the ladders' rungs stay in the record, the pair does not.
        run.CoreCertified = null;
        run.MemoryCertified = null;
        lock (run)
            run.Stops.Add(new(TuneLadderKind.Core, TuneStopReason.Inconsistent, pair.CoreMhz - baseline.CoreMhz, null, $"the official run of the certified pair failed twice ({run.Official!.Note}); the pair is not certified"));
        Finish(run);
    }

    /// <summary>The end-of-run truth (plan section 16, rule 4): once the baseline is back, a
    /// short sustained load reads what the card holds now, for the page and the export to put
    /// beside the card as found. Skipped when nothing was ever written (the card is untouched
    /// by definition), when the user stopped the run, after a driver reset (the card has had
    /// enough), or when the restore itself failed (the rung may still be on).</summary>
    private async Task HoldsNowAsync(TuneRunContext run, TuneRunState end)
    {
        if (!run.Wrote || !run.Restored || end == TuneRunState.Stopped || run.DeviceLostCount > 0 || run.Cancel.IsCancellationRequested)
            return;
        run.Phase = TunePhase.HoldsNow;
        Begin(run, run.Baseline!);
        try
        {
            Event(run, $"measuring what the card holds now, {TuneLadder.HoldsNowSeconds} s sustained at the baseline");
            var outcome = await LaunchPatternAsync(run, TunePattern.Sustained, TuneLadder.HoldsNowSeconds, CancellationToken.None);
            if (outcome.ExitCode != 0 || outcome.MaxSmMhz == 0)
            {
                Event(run, $"the card's held clocks after the restore could not be read (worker exit {outcome.ExitCode})");
                return;
            }
            run.HoldsNow = new HeldClocks(outcome.MaxSmMhz, outcome.MaxMemMhz);
            var asFound = run.BaselineHeld;
            Event(run, asFound is null ? $"the card holds {run.HoldsNow.SmMhz} / {run.HoldsNow.MemMhz} MHz now"
                : TuneLadder.HoldsDiffer(asFound, run.HoldsNow)
                    ? $"the card holds {run.HoldsNow.SmMhz} / {run.HoldsNow.MemMhz} MHz now; as found {asFound.SmMhz} / {asFound.MemMhz}: re-apply your tune in the vendor tool"
                    : $"the card holds {run.HoldsNow.SmMhz} / {run.HoldsNow.MemMhz} MHz now; as found {asFound.SmMhz} / {asFound.MemMhz}: the same");
            if (run.Result is { } r)
            {
                run.Result = r with { HoldsNow = run.HoldsNow };
                store.Result(run.Result);
            }
        }
        catch (Exception e) when (e is TuneAbort or OperationCanceledException or IOException)
        {
            Event(run, $"the card's held clocks after the restore were not measured: {e.Message}");
        }
    }

    // The held clock the ladder reasons about: the top of the curve for the core (the
    // variable half, where the offset shows without the cap), the sustained half's memory
    // clock for memory (load-independent in P0).
    private static uint? HeldFigure(TuneCandidate candidate, TuneLadderKind ladder) =>
        ladder == TuneLadderKind.Core ? candidate.TopSmMhz : candidate.Held?.MemMhz;

    /// <summary>The checks on the held clock, in this order: a climb the driver did not add on
    /// top of the card's tune (the held clock fell: our write replaced it) is the ladder's
    /// refusal; a core rung whose top of the curve did not move is judged on the sustained
    /// half's mean clock and throughput against the as-found spread (plan section 16: on the
    /// power cap a shifted curve is a higher clock at the same watts), and when none of the
    /// three moved the card is at the top of its clock table, certified +0 core, a result and
    /// not a failure; a tool changing clocks under us aborts the run (the rest of it could
    /// not be trusted); and once additivity is decided a core rung that gains nothing over
    /// the rung below ends the climb at the previous rung. While the additivity check is open
    /// it is judged on the whole offset written so far, and a first rung within a bin of the
    /// baseline leaves it to the second (TuneLadder.JudgeAdditivity); <c>decided</c> says
    /// whether this rung closed it. A rung that died before its clocks were measured is left
    /// to its own verdict; a rung certified before a failed additivity decision is dropped.</summary>
    private (TuneLadderStop? Stop, bool Decided) CheckHeld(TuneRunContext run, TuneLadderKind ladder, TuneCandidate candidate, TuneCandidate? previous, uint baselineHeld, string source, int offsetMhz, bool additivityOpen, bool climbing)
    {
        if (HeldFigure(candidate, ladder) is not { } held)
            return (null, false);
        var rung = TuneLadder.StepKhz(ladder) / 1000;
        var core = ladder == TuneLadderKind.Core;
        var climb = run.ClimbFrom!;
        var clockNoise = TuneLadder.MeanClockNoiseMhz(run.BaselineMeanSmSpreadMhz);
        var workNoise = TuneLadder.ThroughputNoise(run.BaselineThroughputSpread);
        string OnCap(double? mean, double? reference, double? work, double? referenceWork) =>
            $"{mean?.ToString("F0") ?? "?"} MHz sustained mean against {reference?.ToString("F0") ?? "?"}, {work?.ToString("F2") ?? "?"} against {referenceWork?.ToString("F2") ?? "?"} Gsteps/s";
        if (additivityOpen)
        {
            var additivity = TuneLadder.JudgeAdditivity(held, baselineHeld, offsetMhz, rung);
            // A held clock that fell by more than a bin is our write replacing the tune, whatever the cap says.
            if (additivity == TuneLadder.Additivity.Failed && held + TuneLadder.ClockBinMhz < baselineHeld)
            {
                Certify(run, ladder, null);
                return (new(ladder, TuneStopReason.Additivity, 0, null, $"the driver is not adding our offset on top of your tune, it replaced it: the +{offsetMhz} MHz {ladder} rung held {held} MHz where the baseline held {baselineHeld} ({source}; the stock clock plus our rung). Re-apply your tune in the vendor tool now; to hunt, zero it there first and the values found are the whole tune"), true);
            }
            if (additivity != TuneLadder.Additivity.Passed && core && TuneLadder.GainedOnCap(candidate.MeanSmMhz, climb.MeanSm, clockNoise, candidate.ThroughputGsps, climb.Throughput, workNoise))
            {
                Event(run, $"additivity shown on the cap: the +{offsetMhz} MHz core rung holds {held} MHz at the top of the curve against {baselineHeld} {source} (the curve's top does not move), but {OnCap(candidate.MeanSmMhz, climb.MeanSm, candidate.ThroughputGsps, climb.Throughput)} say the offset counts where the card runs");
                return (null, true);
            }
            if (additivity == TuneLadder.Additivity.Failed)
            {
                Certify(run, ladder, null);
                return core
                    ? (new(ladder, TuneStopReason.TopOfTable, 0, null, $"the card already runs at the top of its clock table ({baselineHeld} MHz {source}; +{offsetMhz} MHz core read {held} MHz at the top of the curve, {OnCap(candidate.MeanSmMhz, climb.MeanSm, candidate.ThroughputGsps, climb.Throughput)}, all within the as-found run's spread); no core headroom above it through offsets, certified +0 core"), true)
                    : (new(ladder, TuneStopReason.Additivity, 0, null, $"the driver is not adding our offset on top of your tune: the +{offsetMhz} MHz {ladder} rung held {held} MHz against {baselineHeld} MHz {source} (at least {baselineHeld + (uint)Math.Ceiling(TuneLadder.AdditivityShare * offsetMhz)} was expected)"), true);
            }
            if (core ? TuneLadder.MovedFromPrevious(held, previous?.TopSmMhz, baselineHeld, offsetMhz, rung) : TuneLadder.Moved(held, baselineHeld, offsetMhz, rung))
                throw new TuneAbort(MovedSentence(ladder, held, previous?.TopSmMhz, baselineHeld, source, offsetMhz));
            Event(run, additivity == TuneLadder.Additivity.Undecided
                ? $"additivity not yet shown: the +{offsetMhz} MHz {ladder} rung holds {held} MHz against {baselineHeld} MHz {source}, within a bin; the +{offsetMhz + rung} MHz rung decides"
                : $"additivity check passed: the +{offsetMhz} MHz {ladder} rung holds {held} MHz against {baselineHeld} MHz {source}");
            return (null, additivity == TuneLadder.Additivity.Passed);
        }
        if (core ? TuneLadder.MovedFromPrevious(held, previous?.TopSmMhz, baselineHeld, offsetMhz, rung) : TuneLadder.Moved(held, baselineHeld, offsetMhz, rung))
            throw new TuneAbort(MovedSentence(ladder, held, previous?.TopSmMhz, baselineHeld, source, offsetMhz));
        // Additivity shown, the climb goes on: a core rung that lifts neither the top of the
        // curve by a bin nor the sustained figures over the rung below adds nothing the user
        // could type; the ladder ends at the rung below rather than climbing blind to the
        // driver's range with every rung "stable".
        if (climbing && core && candidate.Verdict == TuneVerdict.Stable && previous is { TopSmMhz: { } previousTop }
            && held < previousTop + TuneLadder.ClockBinMhz
            && !TuneLadder.GainedOnCap(candidate.MeanSmMhz, previous.MeanSmMhz, clockNoise, candidate.ThroughputGsps, previous.ThroughputGsps, workNoise))
        {
            var previousOffset = offsetMhz - rung;
            return (new(ladder, TuneStopReason.TopOfTable, previousOffset, null, $"the top of the clock table: +{offsetMhz} MHz core read {held} MHz at the top of the curve against {previousTop} at +{previousOffset}, {OnCap(candidate.MeanSmMhz, previous.MeanSmMhz, candidate.ThroughputGsps, previous.ThroughputGsps)}, all within the as-found run's spread; no core headroom above +{previousOffset} through offsets"), false);
        }
        Event(run, $"held {held} MHz at +{offsetMhz} MHz {ladder}, as expected from {(core && previous?.TopSmMhz is { } p ? $"{p} MHz at the rung below" : $"{baselineHeld} MHz {source}")}");
        return (null, false);
    }

    private static string MovedSentence(TuneLadderKind ladder, uint held, uint? previousTop, uint baselineHeld, string source, int offsetMhz) =>
        previousTop is { } p && ladder == TuneLadderKind.Core
            ? $"another tool is changing the core clock under the test: the card held {held} MHz at the top of the curve where the rung below held {p}, while our offset rose by one rung (a profile timer or a fan-curve app re-applying its tune); close it for the run, its settings stay applied"
            : $"another tool is changing the {ladder} clock under the test: the card held {held} MHz where the baseline ({baselineHeld} MHz {source}) plus our +{offsetMhz} MHz would put {baselineHeld + offsetMhz}, while our offset stayed constant (a profile timer or a fan-curve app re-applying its tune); close it for the run, its settings stay applied";

    private static int Offset(TuneDeltas deltas, TuneLadderKind ladder) => ladder == TuneLadderKind.Core ? deltas.CoreKhz : deltas.MemKhz;

    private static TuneDeltas With(TuneDeltas baseline, TuneLadderKind ladder, int khz) =>
        ladder == TuneLadderKind.Core ? baseline with { CoreKhz = khz } : baseline with { MemKhz = khz };

    // The driver's SM clock ceiling moves with the P0 offset on it (the user's +319 holds 3225
    // against a 3090 table maximum), so the top of the curve is compared with the ceiling
    // plus the offset the rung carries.
    private uint? Ceiling(int coreDeltaMhz) => sources.NvmlSampler?.Latest.FirstOrDefault()?.ClockOffsets?.MaxClockSmMhz is { } c ? (uint)(c + coreDeltaMhz) : null;

    /// <summary>The request's cap on rungs per ladder (a bounded smoke test): reached, the
    /// ladder ends with what it has and says so; the result is unconverged and low confidence.</summary>
    private bool CapReached(TuneRunContext run) => run.MaxCandidates is { } max && run.Rungs >= max;

    /// <summary>The result as it stands after each ladder, so a later ladder's abort never
    /// loses an earlier ladder's finding: the certified offsets, the card as found and at the
    /// certified rungs, the first real failure, and why each ladder ended.</summary>
    private void Finish(TuneRunContext run)
    {
        var baseline = run.Baseline!;
        var deltas = new TuneDeltas(run.CoreCertified?.Deltas.CoreKhz ?? baseline.CoreKhz, run.MemoryCertified?.Deltas.MemKhz ?? baseline.MemKhz);
        var held = run.BaselineHeld is { } found
            ? new HeldClocks(run.CoreCertified?.Held?.SmMhz ?? found.SmMhz, run.MemoryCertified?.Held?.MemMhz ?? found.MemMhz)
            : null;
        List<TuneLadderStop> stops;
        lock (run)
            stops = run.Stops.ToList();
        var firstFailure = stops.FirstOrDefault(s => TuneLadder.IsFailure(s.Reason));
        var converged = stops.All(s => TuneLadder.Converged(s.Reason));
        var atDriverMax = stops.Any(s => s.Reason is TuneStopReason.DriverMax or TuneStopReason.Ceiling or TuneStopReason.TopOfTable);
        var aboveBaseline = deltas != baseline;
        var anyInvalid = run.Candidates.Any(c => c.Verdict == TuneVerdict.Invalid);
        var confidence = TuneLadder.Confidence(converged, atDriverMax, run.DeviceLostCount, anyInvalid, aboveBaseline);
        if (run.Official is { Verdict: not TuneVerdict.Stable })
            confidence = TuneConfidence.Low;
        List<TuneCandidate> rungs;
        lock (run)
            rungs = run.Candidates.ToList();
        run.Result = new TuneResult(run.Kind, deltas, baseline, run.Vendor, run.BaselineHeld, held, firstFailure, stops, run.MemoryCertified?.BandwidthGBs, run.ReferenceHash!, confidence, DateTimeOffset.UtcNow.ToString("O"))
        {
            AsFound = run.AsFound,
            Official = run.Official,
            HoldsNow = run.HoldsNow,
            Rungs = rungs,
        };
        store.Result(run.Result);
        var certified = run.Result.Certified;
        Event(run, aboveBaseline
            ? $"result: certified +{certified.CoreMhz} core / +{certified.MemMhz} memory on top of {(run.Vendor is { } v ? $"your tune (core +{v.CoreMhz} / memory +{v.MemMhz} on the slider)" : "the card as found")} ({run.BaselineHeld?.SmMhz} / {run.BaselineHeld?.MemMhz} → {held?.SmMhz} / {held?.MemMhz} MHz){(firstFailure is { } f ? $"; first failure at +{f.OffsetMhz} {f.Ladder} (stage {f.Stage})" : "")}; {confidence} confidence"
            : $"nothing above the baseline could be certified: {string.Join("; ", stops.Select(s => s.Note))}");
    }

    /// <summary>The as-found run writes nothing (the write itself can take a vendor tool's
    /// tune off the card); the vendor rung writes the user's tune and is not a climb; a climb
    /// rung writes and counts toward the request's cap; the official run writes the pair.</summary>
    private enum RungKind { AsFound, Vendor, Climb, Official }

    /// <summary>A scored run: <see cref="TuneLadder.ScoredRepeats"/> repeats of the shape at
    /// one set of offsets, with the flight recorder's telemetry window open around them, the
    /// score from the mean of the repeats, the held clocks their peaks.</summary>
    private async Task<(ScoredRun Run, TuneStopReason? Stop)> ScoredAsync(TuneRunContext run, TuneDeltas deltas, RungKind kind, CancellationToken ct)
    {
        recorder.BeginWindow(TelemetryIds.Find(sources.Lhm?.Metas ?? [], sources.NvmlSampler?.Latest.FirstOrDefault()?.Name));
        TuneCandidate entry;
        TuneStopReason? stop;
        TelemetrySummary? telemetry;
        try
        {
            (entry, stop) = await RungAsync(run, TuneLadderKind.Memory, deltas, kind, ct, TuneLadder.ScoredRepeats);
        }
        finally
        {
            run.Repeat = 0;
            // Closed before any re-measure at the baseline, so the sheet's tables hold the pair's own samples only.
            telemetry = recorder.EndWindow();
        }
        if (stop == TuneStopReason.Bandwidth && kind == RungKind.Official)
            (entry, stop) = await ReconsiderBandwidthAsync(run, entry, ct);
        return (new ScoredRun(deltas, TuneLadder.ScoredRepeats, entry.Verdict, entry.Score, entry.Held, entry.TopSmMhz, entry.Note, telemetry, false) { MeanSmMhz = entry.MeanSmMhz }, stop);
    }

    /// <summary>
    /// A bandwidth fall is confirmed before it counts (dev box, runs 154463d9b2f1 and
    /// bb09b0a0455c: the stream pass reads in two modes about 9 % apart, 1520 and 1660 GB/s,
    /// at the same memory clock, and a mode that flips mid-run would fail every later rung
    /// against a best certified in the other mode). The baseline goes back on the card and a
    /// short sustained launch reads the bus again: a baseline that now reads under the best
    /// by the same rule is the bus itself in its other mode, not the rung, so the rung is
    /// judged against that reading, the floor is re-based to it, and the rung's own figure
    /// still has to stay within the rule of it. A baseline that still reads at the best
    /// leaves the regression standing. The rung is replaced in the run's list when it turns.
    /// </summary>
    private async Task<(TuneCandidate Entry, TuneStopReason? Stop)> ReconsiderBandwidthAsync(TuneRunContext run, TuneCandidate entry, CancellationToken ct)
    {
        if (entry.BandwidthGBs is not { } fell || run.BestBandwidthGBs is not { } best)
            return (entry, TuneStopReason.Bandwidth);
        Event(run, $"bandwidth {fell:F0} GB/s at P0 core +{entry.Deltas.CoreMhz} / memory +{entry.Deltas.MemMhz} MHz is more than {TuneLadder.RegressionFloor(run.BaselineSpread):P1} under the best certified {best:F0}: re-measuring the bus at the baseline before calling it a regression");
        ApplyBaselineNow(run, "the bandwidth check");
        Begin(run, run.Baseline!);
        var outcome = await LaunchPatternAsync(run, TunePattern.Sustained, TuneLadder.BandwidthCheckSeconds, ct);
        if (TuneLadder.PatternVerdict(outcome.ExitCode, outcome.HeartbeatStale) is { Verdict: TuneVerdict.DeviceLost })
        {
            CountDeviceLost(run);
            throw new TuneAbort("the card lost its device at the baseline during the bandwidth check, with nothing of ours on top: it is not stable as it is");
        }
        if (outcome.ExitCode != 0 || outcome.BandwidthGBs is not { } now)
        {
            Event(run, $"the bus could not be re-measured at the baseline (worker exit {outcome.ExitCode}); the regression stands");
            return (entry, TuneStopReason.Bandwidth);
        }
        if (!TuneLadder.Regressed(now, best, run.BaselineSpread))
        {
            Event(run, $"the baseline re-measured at {now:F0} GB/s, still at the best {best:F0}: the fall to {fell:F0} is the rung's");
            return (entry, TuneStopReason.Bandwidth);
        }
        run.BestBandwidthGBs = now;
        if (TuneLadder.Regressed(fell, now, run.BaselineSpread))
        {
            Event(run, $"the baseline re-measured at {now:F0} GB/s (the bus in its lower mode; the floor is re-based to it), and {fell:F0} at the rung is still more than {TuneLadder.RegressionFloor(run.BaselineSpread):P1} under it: the regression stands");
            return (entry with { Note = $"{entry.Note}; the bus re-measured at {now:F0} GB/s at the baseline" }, TuneStopReason.Bandwidth);
        }
        var turned = entry with
        {
            Verdict = TuneVerdict.Stable,
            Stage = null,
            FailedPattern = null,
            Note = $"every pass matched; bandwidth {fell:F0} GB/s read under the best certified {best:F0}, but the baseline re-measured right after read {now:F0}: the bus itself moved (this card's stream copy reads in two modes), not the rung; judged against {now:F0} from here{(entry.Score is { } s ? $"; {s.Points} points" : "")}",
        };
        if (run.ErrorCount > 0)
            run.ErrorCount--;
        run.Stage = null;
        lock (run)
        {
            var i = run.Candidates.IndexOf(entry);
            if (i >= 0)
                run.Candidates[i] = turned;
        }
        Event(run, $"{turned.Ladder} rung at P0 core +{turned.Deltas.CoreMhz} / memory +{turned.Deltas.MemMhz} MHz reconsidered: {turned.Note}");
        return (turned, null);
    }

    /// <summary>One rung: the shape (variable, then sustained) once for a climb rung, repeated
    /// for a scored run. The file says PENDING before the driver hears the value; the halves
    /// run in order and the first that trips ends the rung; a rung that passes them all is
    /// judged on the cooler's bits, its sustained throughput (core) or bandwidth (memory)
    /// against the best certified so far, and the consistency of its repeats, and scored.
    /// The rung is recorded whatever happens to it, with the stop reason its verdict implies,
    /// and a device loss puts the baseline back before anything else.</summary>
    private async Task<(TuneCandidate Entry, TuneStopReason? Reason)> RungAsync(TuneRunContext run, TuneLadderKind ladder, TuneDeltas deltas, RungKind kind, CancellationToken ct, int repeats = 1)
    {
        await WaitAfterDeviceLostAsync(run, ct);
        if (kind == RungKind.AsFound)
            Begin(run, deltas);
        else
            Apply(run, deltas, ct);
        if (kind == RungKind.Climb)
            run.Rungs++;
        var scored = kind is RungKind.AsFound or RungKind.Official;
        TuneCandidate entry;
        uint heavySm = 0, heavyMem = 0, topSm = 0;
        var anyTop = false;
        var throttled = new List<double>();
        var thermal = new List<double>();
        var passes = new List<double>();
        var throughputs = new List<double>();
        var means = new List<double>();
        HeldClocks? Held() => heavySm > 0 ? new HeldClocks(heavySm, heavyMem) : null;
        uint? Top() => anyTop ? topSm : null;
        static double Share(List<double> shares) => shares.Count == 0 ? 0 : shares.Average();
        TuneCandidate Failed(TuneVerdict verdict, int? stage, TunePattern pattern, string note) =>
            new(ladder, deltas, verdict, stage, pattern, Held(), Top(), Mean(throughputs), Mean(passes), Share(throttled), note) { MeanSmMhz = Mean(means) };
        for (var repeat = 1; repeat <= repeats; repeat++)
        {
            run.Repeat = repeats > 1 ? repeat : 0;
            foreach (var (pattern, seconds) in TuneLadder.RungShape)
            {
                var outcome = await LaunchPatternAsync(run, pattern, seconds, ct);
                if (pattern == TunePattern.Sustained)
                {
                    throttled.Add(outcome.ThrottledFraction);
                    thermal.Add(outcome.ThermalFraction);
                    heavySm = Math.Max(heavySm, outcome.MaxSmMhz);
                    heavyMem = Math.Max(heavyMem, outcome.MaxMemMhz);
                    if (outcome.BandwidthGBs is { } bw)
                        passes.Add(bw);
                    if (outcome.ThroughputGsps is { } t)
                        throughputs.Add(t);
                    if (outcome.MeanSmMhz is { } m)
                        means.Add(m);
                }
                else
                {
                    topSm = Math.Max(topSm, outcome.MaxSmMhz);
                    anyTop = true;
                }
                if (outcome.Drifted)
                {
                    Record(run, kind, Failed(TuneVerdict.Invalid, null, pattern, "invalid: our clock offsets changed under the test (another tool wrote the P0 deltas)"));
                    throw new TuneAbort("another tool wrote the clock offsets under the test: the driver no longer holds our rung, so nothing from here on could be trusted; close the tool for the run, its settings stay applied");
                }
                var verdict = TuneLadder.PatternVerdict(outcome.ExitCode, outcome.HeartbeatStale)
                    ?? throw new TuneAbort($"the worker failed under the {pattern.ToString().ToLowerInvariant()} half (exit {outcome.ExitCode}): {Tail(outcome.Stderr)}");
                if (verdict.Verdict == TuneVerdict.DeviceLost)
                {
                    CountDeviceLost(run);
                    ApplyBaselineNow(run, "device lost");
                    run.Stage = 3;
                    entry = Failed(TuneVerdict.DeviceLost, 3, pattern, outcome.HeartbeatStale ? "no heartbeat for 6 s on two reads: killed and counted as a driver reset" : $"driver reset (device lost): {Tail(outcome.Stderr)}");
                    Record(run, kind, entry);
                    if (run.DeviceLostCount >= MaxDeviceLost)
                        throw new TuneAbort("two driver resets in one run: stopping here (Windows bug-checks on repeated GPU hangs)");
                    return (entry, TuneStopReason.DeviceLost);
                }
                if (verdict.Verdict == TuneVerdict.Unstable)
                {
                    run.ErrorCount++;
                    run.Stage = verdict.Stage;
                    entry = Failed(TuneVerdict.Unstable, verdict.Stage, pattern, $"silent error, hash mismatch under the {pattern.ToString().ToLowerInvariant()} half: {Tail(outcome.Stderr)}");
                    Record(run, kind, entry);
                    return (entry, TuneStopReason.Hash);
                }
            }
        }
        var bandwidth = Mean(passes);
        var throughput = Mean(throughputs);
        var spread = TuneLadder.Spread(passes);
        if (kind == RungKind.AsFound)
        {
            // The as-found repeats are separate launches: their spread is every later rung's noise floor.
            run.BaselineSpread = spread;
            run.BaselineThroughputSpread = TuneLadder.Spread(throughputs);
            run.BaselineMeanSmSpreadMhz = means.Count > 1 ? means.Max() - means.Min() : null;
        }
        // The as-found run has no best to fall under: it sets the floor.
        var judged = TuneLadder.Judge(ladder, Share(thermal), throughput, kind == RungKind.AsFound ? null : run.BestThroughputGsps, bandwidth, kind == RungKind.AsFound ? null : run.BestBandwidthGBs, spread, run.BaselineSpread);
        // A scored run's stage-2 check is on both axes: the pair is judged whole.
        if (scored && judged.Verdict == TuneVerdict.Stable && kind == RungKind.Official && throughput is { } tp && TuneLadder.ThroughputFell(tp, run.BestThroughputGsps))
            judged = (TuneVerdict.Unstable, 2, TuneStopReason.Throughput);
        if (judged.Verdict == TuneVerdict.Unstable)
        {
            run.ErrorCount++;
            run.Stage = 2;
        }
        else
        {
            run.Stage = null;
        }
        // Each ladder raises its own floor: the memory ladder's bandwidth and the core ladder's
        // throughput. A core rung's stream pass (memory back at the baseline) says nothing about
        // the memory, and a memory rung's throughput nothing about the core.
        if (judged.Verdict == TuneVerdict.Stable && kind == RungKind.Climb)
        {
            if (ladder == TuneLadderKind.Memory && bandwidth is { } b && !(run.BestBandwidthGBs > b))
                run.BestBandwidthGBs = b;
            if (ladder == TuneLadderKind.Core && throughput is { } t && !(run.BestThroughputGsps > t))
                run.BestThroughputGsps = t;
        }
        var score = TuneScoring.Score(throughput, bandwidth);
        var cap = Share(throttled) > 0 ? $"; power-capped {Share(throttled):P0} of the sustained samples (normal)" : "";
        var points = score is { } sc ? $"; {sc.Points} points" : "";
        entry = new TuneCandidate(ladder, deltas, judged.Verdict, judged.Stage, judged.Verdict == TuneVerdict.Unstable ? TunePattern.Sustained : null, Held(), Top(), throughput, bandwidth, Share(throttled), judged.Stop switch
        {
            TuneStopReason.Thermal => $"the cooler, not the clock, is the limit: a thermal-limit bit was set on {Share(thermal):P0} of the sustained samples",
            TuneStopReason.Inconsistent => $"bandwidth inconsistent across the repeats ({spread:P1} spread; another GPU user, or the sampler's own load)",
            TuneStopReason.Throughput => $"sustained throughput {throughput:F2} Gsteps/s fell more than {TuneLadder.ThroughputRegression:P0} under the best certified rung's {run.BestThroughputGsps:F2}{cap}",
            TuneStopReason.Bandwidth => $"bandwidth {bandwidth:F0} GB/s is more than {TuneLadder.RegressionFloor(run.BaselineSpread):P1} under the best certified rung's {run.BestBandwidthGBs:F0}",
            _ => $"every pass matched; {throughput:F2} Gsteps/s sustained, {bandwidth:F0} GB/s{(passes.Count > 1 ? $" (mean of {passes.Count}, {spread:P1} spread)" : "")}{cap}{points}",
        })
        {
            Score = score,
            MeanSmMhz = Mean(means),
        };
        Record(run, kind, entry);
        return (entry, judged.Stop);
    }

    private static double? Mean(List<double> values) => values.Count == 0 ? null : values.Average();

    private static double? Median(List<double> values) => values.Count == 0 ? null : TuneLadder.Median(values);

    private void CountDeviceLost(TuneRunContext run)
    {
        run.DeviceLostCount++;
        run.ErrorCount++;
        run.LastDeviceLost = DateTimeOffset.UtcNow;
        store.DeviceLost();
    }

    // Serialised with Restore on the run's apply gate: a shutdown that restored the
    // baseline a moment ago must not be followed by one more apply, and an apply that
    // slips in anyway re-arms the restore. The disk must take PENDING first: a rung
    // on the card while the file still says IDLE is a hang nobody could attribute.
    private void Apply(TuneRunContext run, TuneDeltas deltas, CancellationToken ct)
    {
        lock (run.ApplyGate)
        {
            ct.ThrowIfCancellationRequested();
            Begin(run, deltas);
            if (!store.Pending(deltas, $"applying P0 offsets core {deltas.CoreMhz} / memory {deltas.MemMhz} MHz"))
                throw new TuneAbort($"the state file at {TuneStateStore.FilePath} could not be written, so nothing was applied: a rung the disk does not know about could never be reverted after a hang");
            run.Applied = true;
            run.Wrote = true;
            run.Restored = false;
            var ok = NvapiPstates.ApplyDeltas(deltas, out var status);
            log.Write($"tune run {run.Id}: apply {(ok ? "ok" : "FAILED")}: {status}");
            Event(run, ok ? $"applied P0 offsets core +{deltas.CoreMhz} / memory +{deltas.MemMhz} MHz" : $"apply failed: {status}");
            if (!ok)
                throw new TuneAbort($"the driver refused the rung: {status}");
        }
    }

    // The rung's live fields, for the 2 Hz snapshot and the drift check.
    private static void Begin(TuneRunContext run, TuneDeltas deltas)
    {
        run.Candidate = deltas;
        run.Stage = null;
        run.Pattern = null;
        run.BandwidthGBs = null;
        run.Validity = TuneValidity.Unknown;
    }

    // The desktop, DWM and the user's other apps must not run on a driver that just
    // recovered from a TDR at the offset that hung it: the baseline goes back at once, and
    // the 15 s gap is waited at safe clocks. The same call ends a ladder, so the next one
    // measures the card as found. A refusal here is left to the finally's retries.
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
            store.Idle($"baseline back after {why}: {status}");
        }
    }

    /// <summary>Every rung is logged; only the ladder's own rungs (the vendor rung and the
    /// climb) join the candidate list the score climb draws, because the as-found and official
    /// runs travel as <c>asFound</c> / <c>official</c> and would otherwise show twice.</summary>
    private void Record(TuneRunContext run, RungKind kind, TuneCandidate candidate)
    {
        if (kind is RungKind.Vendor or RungKind.Climb)
            lock (run)
                run.Candidates.Add(candidate);
        var held = candidate.Held is { } h ? $"; held {h.SmMhz} / {h.MemMhz} MHz sustained{(candidate.MeanSmMhz is { } m ? $" ({m:F0} mean)" : "")}{(candidate.TopSmMhz is { } t ? $", {t} MHz top" : "")}" : "";
        Event(run, $"{candidate.Ladder} rung at P0 core +{candidate.Deltas.CoreMhz} / memory +{candidate.Deltas.MemMhz} MHz: {candidate.Verdict}{(candidate.Stage is { } s ? $" (stage {s})" : "")}: {candidate.Note}{held}");
    }

    private async Task WaitAfterDeviceLostAsync(TuneRunContext run, CancellationToken ct)
    {
        var until = run.LastDeviceLost + DeviceLostGap;
        if (DateTimeOffset.UtcNow >= until)
            return;
        Event(run, "waiting 15 s after the driver reset, at the baseline, before the next launch");
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

    // The stage-1 reference: the hash every rung's passes are checked against, taken with
    // nothing of ours applied. The clocks the card holds are measured by the as-found run,
    // not here: the reference is two passes, under a second.
    private async Task<string> ReferenceAsync(TuneRunContext run, CancellationToken ct)
    {
        run.Phase = TunePhase.Reference;
        Event(run, "capturing the reference hash with nothing of ours applied");
        var outcome = await LaunchAsync(run, ["--reference", "--json", "--adapter", run.Luid!], TimeSpan.FromSeconds(60), null, ct);
        if (outcome.ExitCode == 10 || outcome.HeartbeatStale)
        {
            CountDeviceLost(run);
            throw new TuneAbort("the card lost its device during the reference run, with nothing of ours applied: it is not stable as it is, and no hunt can start from there");
        }
        if (outcome.ExitCode == 2)
            throw new TuneAbort("the card cannot repeat its own reference as found: it is not stable as it is, and no hunt can start from there");
        if (outcome.ExitCode != 0)
            throw new TuneAbort($"the reference run failed (exit {outcome.ExitCode}): {Tail(outcome.Stderr)}");
        var hash = LastJsonLine(outcome.Stdout)?.TryGetProperty("hash", out var h) == true ? h.GetString() : null;
        if (string.IsNullOrEmpty(hash))
            throw new TuneAbort("the reference run printed no hash");
        Event(run, $"reference hash {hash}");
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

    /// <summary>Starts the worker beside this exe and watches it: the clocks at 10 Hz for
    /// the peaks, and at 2 Hz the flight recorder samples, the limit bits are counted under
    /// the sustained half, a heartbeat older than 6 s on two reads or a deadline passed kills
    /// it and counts as a driver reset, an offset that changed under the test kills it and
    /// marks the rung invalid, and a stalled collector aborts the run. The worker's last
    /// JSON line carries the bandwidth and the throughput.</summary>
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
        var countLimits = pattern == TunePattern.Sustained;
        log.Write($"tune run {run.Id}: worker {string.Join(' ', args)}");

        var started = DateTimeOffset.UtcNow;
        bool stale = false, drifted = false;
        int throttledTicks = 0, thermalTicks = 0, ticks = 0, staleReads = 0;
        uint maxSm = 0, maxMem = 0, lastSm = 0;
        // The settled window's SM samples at 10 Hz, for the sustained half's mean (plan section 16: the whole 30 s averaged).
        long smSum = 0;
        var smSamples = 0;
        var lastAge = TimeSpan.Zero;
        try
        {
            using var process = Process.Start(info) ?? throw new TuneAbort("the worker did not start");
            run.Worker = process;
            var stdout = process.StandardOutput.ReadToEndAsync();
            var stderr = process.StandardError.ReadToEndAsync();
            using var timer = new PeriodicTimer(ClockPeriod);
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
                return new WorkerOutcome(10, true, drifted, Fraction(throttledTicks), Fraction(thermalTicks), null, null, maxSm, maxMem, "", "the worker could not be torn down") { MeanSmMhz = MeanSm() };
            }
            var outText = await stdout;
            var errText = await stderr;
            ct.ThrowIfCancellationRequested();
            var json = LastJsonLine(outText);
            var bandwidth = Number(json, "bandwidthGBs");
            var throughput = Number(json, "steps") is { } steps && Number(json, "busyMs") is > 0 and var busy ? steps / busy / 1e6 : (double?)null;
            if (bandwidth is { } b)
                run.BandwidthGBs = b;
            // The stream pass's own distribution and the SM clock in its last second (the copy is a
            // light SM load the boost governor may idle) are logged because the pass reads in two
            // modes on the dev box (1520 / 1660 GB/s at one memory clock, runs 154463d9b2f1 and
            // bb09b0a0455c) and the cause is still to be pinned live.
            var buffer = Number(json, "bandwidthBufferBytes") is { } bytes ? $"{bytes / (1 << 20):F0} MiB" : "-";
            var copy = bandwidth is null ? "" : $" (stream pass: {Number(json, "bandwidthPasses")?.ToString("F0") ?? "-"} passes, {Number(json, "bandwidthMinGBs")?.ToString("F0") ?? "-"}..{Number(json, "bandwidthMaxGBs")?.ToString("F0") ?? "-"} GB/s, buffer {buffer}, SM clock {lastSm} MHz at the end)";
            log.Write($"tune run {run.Id}: worker exit {process.ExitCode}{(stale ? " (killed)" : "")}{(drifted ? " (offset drifted)" : "")}, bandwidth {bandwidth?.ToString("F1") ?? "-"} GB/s{copy}, throughput {throughput?.ToString("F2") ?? "-"} Gsteps/s, limit bits {Fraction(throttledTicks):P0} (thermal {Fraction(thermalTicks):P0}), peak core {maxSm} / memory {maxMem} MHz{(MeanSm() is { } mean ? $", mean core {mean:F0}" : "")}{(errText.Length > 0 ? $", stderr: {Tail(errText)}" : "")}");
            return new WorkerOutcome(stale ? 10 : process.ExitCode, stale, drifted, Fraction(throttledTicks), Fraction(thermalTicks), bandwidth, throughput, maxSm, maxMem, outText, errText) { MeanSmMhz = MeanSm() };

            double Fraction(int count) => ticks == 0 ? 0 : count / (double)ticks;

            double? MeanSm() => smSamples == 0 ? null : smSum / (double)smSamples;

            async Task WatchAsync()
            {
                var tick = 0;
                while (!process.HasExited)
                {
                    var settled = DateTimeOffset.UtcNow - started > SettleAfterStart;
                    if (settled && sources.NvmlSampler?.Latest.FirstOrDefault() is { } clocks)
                    {
                        maxSm = Math.Max(maxSm, clocks.Clocks.SmMhz);
                        maxMem = Math.Max(maxMem, clocks.Clocks.MemMhz);
                        lastSm = clocks.Clocks.SmMhz;
                        smSum += clocks.Clocks.SmMhz;
                        smSamples++;
                    }
                    if (tick++ % TicksPerSample != 0)
                    {
                        await timer.WaitForNextTickAsync(CancellationToken.None);
                        continue;
                    }
                    var facts = Tick(run);
                    if (countLimits && settled && facts is not null)
                    {
                        ticks++;
                        if ((facts.ClocksEventReasons.Raw & TuneLadder.ThrottleBits) != 0)
                            throttledTicks++;
                        if ((facts.ClocksEventReasons.Raw & TuneLadder.ThermalBits) != 0)
                            thermalTicks++;
                        run.Validity = thermalTicks > ticks * TuneLadder.ThermalFractionLimit ? TuneValidity.Throttled : TuneValidity.Ok;
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
                        Event(run, "worker heartbeat stale for 6 s on two reads: killing it and counting a driver reset");
                    }
                    else if (now - started > deadline)
                    {
                        stale = true;
                        Event(run, $"worker did not exit {ExitGrace.TotalSeconds:0} s past its own deadline: killing it and counting a driver reset");
                    }
                    else if (pattern is not null && run.Candidate is { } expected && NvapiPstates.Cached() is { } held && (held.CoreMhz != expected.CoreMhz || held.MemMhz != expected.MemMhz))
                    {
                        drifted = true;
                        Event(run, $"our clock offsets changed under the test (driver holds core {held.CoreMhz} / memory {held.MemMhz} MHz, the rung is {expected.CoreMhz} / {expected.MemMhz}): killing the worker; this rung proves nothing");
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
    /// the newest GPU facts for the caller's limit-bit count.</summary>
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

    private static double? Number(JsonElement? json, string name) =>
        json is { } j && j.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number ? value.GetDouble() : null;

    private static string Tail(string text)
    {
        var trimmed = text.Trim();
        return trimmed.Length <= 300 ? trimmed : trimmed[^300..];
    }
}
