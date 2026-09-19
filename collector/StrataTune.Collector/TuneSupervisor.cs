using System.Diagnostics;
using StrataTune.Shared;

namespace StrataTune.Collector;

/// <summary>The /tune/* surface: one run at a time, the refusals that keep a hunt honest
/// (plan sections 16 and 20), the revert / enable transitions of the state file, and the
/// status the UI reads. The GPU work is in <see cref="TuneHunt"/>; the file is
/// <see cref="TuneStateStore"/>. Nothing here runs unless Tune is enabled on both sides:
/// the UI's setting arrives with the start request and the state file keeps its own flag.
/// Every mutation (start, revert, enable) goes through one async lock and waits for the
/// revert-at-start pass, so nothing acts on a crash before it has been attributed.</summary>
internal sealed class TuneSupervisor
{
    public const int Conflict = StatusCodes.Status409Conflict, BadRequest = StatusCodes.Status400BadRequest, Forbidden = StatusCodes.Status403Forbidden;
    private const int IdLength = 12;
    // The bench and a capture load the GPU; another worker is a load run. A vendor OC tool
    // may stay open: its applied tune is the baseline, and one that changes clocks mid-run
    // is caught on the held clock (plan section 16, the card as found).
    private static readonly string[] GpuUsers = ["strata-tune-bench", "StrataTune.Bench", "strata-tune-worker"];
    private const string CapturePrefix = "PresentMon-";
    // Windows bug-checks on the sixth GPU hang in 60 s (dependencies.md): no start within
    // 15 s of any device loss, none for 60 s after two, counted across runs and restarts.
    private static readonly TimeSpan LossCooldown = TimeSpan.FromSeconds(15), RepeatedLossCooldown = TimeSpan.FromSeconds(60);
    // The finished run keeps riding the SSE stream this long so the page sees it end.
    private static readonly TimeSpan StreamAfterEnd = TimeSpan.FromSeconds(5);
    // tune-state.json is machine-wide while collectors are per user: under fast user
    // switching a second elevated collector must not write over the first's PENDING.
    private const string MachineMutexName = @"Global\Strata Tune state";

    private readonly Sources _sources;
    private readonly Log _log;
    private readonly TuneStateStore _store;
    private readonly FlightRecorder _recorder;
    private readonly TuneHunt _hunt;
    private readonly Lock _gate = new();
    private readonly SemaphoreSlim _mutation = new(1, 1);
    private readonly Mutex? _machine;
    private readonly bool _ownsMachine;
    private TuneRunContext? _run;
    private volatile bool _reconciled;

    public TuneSupervisor(Sources sources, RingBuffer buffer, string workerPath, Log log)
    {
        _sources = sources;
        _log = log;
        _store = new TuneStateStore(log.Write);
        _recorder = new FlightRecorder(log.Write);
        _hunt = new TuneHunt(this, sources, buffer, workerPath, _store, _recorder, log);
        try
        {
            _machine = new Mutex(false, MachineMutexName);
            _ownsMachine = _machine.WaitOne(0);
        }
        catch (Exception e) when (e is UnauthorizedAccessException or IOException or AbandonedMutexException)
        {
            _ownsMachine = e is AbandonedMutexException;
        }
        if (!_ownsMachine)
            log.Write("tune: another collector on this machine holds the tune state (another user's session); Tune is read-only here");
    }

    /// <summary>The first thing every collector start does (plan section 16): a rung left on
    /// the card by a collector that died is reverted before a port is bound or a sensor
    /// opened, and a crash keeps its flight file. Cheap on an ordinary start: the file is
    /// read, nothing is written to the driver.</summary>
    public void RevertAtStart()
    {
        if (!_ownsMachine)
        {
            _log.Write("tune: revert-at-start pass skipped: another collector owns the state");
            _reconciled = true;
            return;
        }
        var before = _store.Current.State;
        if (!TuneStateMachine.Reconcile(_store, _log.Write, out var outcome))
            _log.Write($"tune: state {outcome.Wire()} could not be reverted at start; the next start, or POST /tune/revert, retries");
        if (_store.Current.State == TuneRollback.Reverted && before != TuneRollback.Reverted)
            FlightRecorder.KeepLastCrash(_log.Write);
        _reconciled = true;
    }

    /// <summary>After the sources have warmed, off the start-up path: the card as found goes
    /// to the log, and a logon task left by the Phase 8 build is removed.</summary>
    public void AfterWarm()
    {
        var deltas = NvapiPstates.ReadDeltas(out var failure);
        _log.Write(deltas is null
            ? $"tune: NVAPI pstates unavailable: {failure}"
            : $"tune: NVAPI P0 deltas core {deltas.Deltas.CoreMhz} / memory {deltas.Deltas.MemMhz} MHz (range core {deltas.CoreMinKhz / 1000}..{deltas.CoreMaxKhz / 1000}, memory {deltas.MemMinKhz / 1000}..{deltas.MemMaxKhz / 1000}, editable {deltas.Editable}, {NvapiPstates.GpuCount} GPU(s)), state {_store.Current.State.Wire()}");
        // The offsets do not survive a boot: a baseline the file remembers from before one
        // is not what the card holds now, and the strip would show a value the card lacks.
        if (deltas is not null && _ownsMachine && _store.Current.State == TuneRollback.Idle && _store.Current.Baseline is { } remembered && remembered != deltas.Deltas)
            _store.Baseline(deltas.Deltas, null, $"baseline re-read from the card at start: the driver holds core {deltas.Deltas.CoreMhz} / memory {deltas.Deltas.MemMhz} MHz, the file remembered {remembered.CoreMhz} / {remembered.MemMhz} (offsets do not survive a reboot)");
        LegacyLogonTask.RemoveIfPresent(_log.Write);
    }

    /// <summary>A run is active until its finally has restored the baseline and released
    /// the lock, not merely until its loop has ended.</summary>
    public bool Active
    {
        get { lock (_gate) return _run is { EndedAt: null }; }
    }

    public bool Enabled => _store.Current.Enabled;

    public TuneHealth Health()
    {
        TuneRunContext? run;
        lock (_gate)
            run = _run;
        return new(_store.Current.State, _store.Current.Reverted, Active, run?.RestoreFailure);
    }

    public TuneStatus Status()
    {
        var f = _store.Current;
        var range = NvapiPstates.ReadDeltas(out var failure);
        return new TuneStatus(f.Enabled, f.State, f.Baseline, f.Candidate, f.AppliedAt, f.Reverted, f.Result, f.History,
            new TuneNvapi(range is not null, failure, range?.Deltas, range), Run(), FlightRecorder.HasLastCrash, TuneStateStore.FilePath)
        {
            Problem = Problem(),
            EstimateMinutes = TuneTiming.EstimateMinutes(TuneRunKind.Hunt, null, f.Vendor is not null),
        };
    }

    /// <summary>The live run for GET /tune/state; null when there is none and never was.</summary>
    public TuneRun? Run()
    {
        lock (_gate)
            return _run?.Snapshot();
    }

    /// <summary>The run for the 2 Hz SSE event: while it goes and for a few seconds after,
    /// so the page sees the end and the stream is otherwise quiet.</summary>
    public TuneRun? RunForStream()
    {
        lock (_gate)
            return _run is { } run && (run.EndedAt is null || DateTimeOffset.UtcNow - run.EndedAt < StreamAfterEnd) ? run.Snapshot() : null;
    }

    private string? Problem() =>
        !_ownsMachine ? "another collector on this machine (another user's session) holds the tune state; Tune is read-only here"
        : !_reconciled ? "the revert-at-start pass has not run yet"
        : _store.Problem;

    /// <summary>A refusal is logged as well as answered: the user reads "it did not work" where the page shows an amber line, and the log must say why.</summary>
    public async Task<(int Status, string Refusal)> TryStartAsync(TuneStartRequest request)
    {
        var r = await TryStartInnerAsync(request);
        if (r.Status != StatusCodes.Status200OK) _log.Write($"tune: start ({request.Kind?.ToString() ?? "hunt"}) refused, HTTP {r.Status}: {r.Refusal}");
        return r;
    }

    private async Task<(int Status, string Refusal)> TryStartInnerAsync(TuneStartRequest request)
    {
        if (request.Enabled == false || !_store.Current.Enabled)
            return (Forbidden, "Tune is not enabled: turn it on in Settings and accept the warning first");
        if (Problem() is { } problem)
            return (Conflict, problem);
        if (_sources.Warming || _sources.NvmlSampler is null)
            return (Conflict, "the collector is still warming, or NVML is absent: a hunt needs the GPU facts");
        if (NvapiPstates.ReadDeltas(out var failure) is null)
            return (Conflict, $"NVAPI cannot read this card's clock offsets: {failure}");
        if (_sources.NvmlSampler.Latest.Count > 1 || NvapiPstates.GpuCount > 1)
            return (Conflict, $"multi-GPU boxes are not supported by Tune yet (NVML sees {_sources.NvmlSampler.Latest.Count}, NVAPI {NvapiPstates.GpuCount}): the offset is written to one card and the load could run on another");
        if (TdrPolicy.Problem() is { } tdr)
            return (Conflict, tdr);
        if (Active)
            return (Conflict, "a tune run is already going");
        if (_store.Current.State == TuneRollback.Pending)
            return (Conflict, "the state file says a rung is still applied and could not be reverted; POST /tune/revert first");
        if (Cooldown() is { } cooling)
            return (Conflict, cooling);
        if (FamilyGpuLock.HeldBy() is { } holder)
            return (Conflict, holder);
        foreach (var name in GpuUsers)
            if (Running(p => string.Equals(p, name, StringComparison.OrdinalIgnoreCase)))
                return (Conflict, $"{name}.exe is running (a bench or a load run): wait for it to finish");
        if (Running(p => p.StartsWith(CapturePrefix, StringComparison.OrdinalIgnoreCase)))
            return (Conflict, "a frame capture is running; stop it first");
        if (await Ollama.ModelsAsync() is { Count: > 0 } models)
            return (Conflict, $"Ollama has {models[0].Name} loaded on the GPU; unload it (or wait for its keep-alive) before a hunt");

        await _mutation.WaitAsync();
        try
        {
            TuneRunContext run;
            lock (_gate)
            {
                if (_run is { EndedAt: null })
                    return (Conflict, "a tune run is already going");
                if (_store.Current.State == TuneRollback.Pending)
                    return (Conflict, "the state changed while the start was being checked; read it again");
                try
                {
                    FamilyGpuLock.Take();
                }
                catch (Exception e) when (e is IOException or UnauthorizedAccessException)
                {
                    return (Conflict, $"the family's gpu.lock could not be taken: {e.Message}");
                }
                if (_store.Current.State == TuneRollback.Reverted)
                    _store.Idle("a new run starts: the last crash's revert is acknowledged");
                run = new TuneRunContext(Guid.NewGuid().ToString("N")[..IdLength], request.EffectiveKind)
                {
                    MaxCandidates = request.MaxCandidates is > 0 and var cap ? cap : null,
                    VendorSlider = request.Vendor,
                    CoreCapMhz = request.CoreCapMhz is > 0 and var coreCap ? coreCap : null,
                    MemCapMhz = request.MemCapMhz is > 0 and var memCap ? memCap : null,
                };
                _run = run;
            }
            _log.Write($"tune run {run.Id}: {run.Kind} start requested{(run.CoreCapMhz is { } cc ? $", never above {cc} MHz core" : "")}{(run.MemCapMhz is { } mc ? $", never above {mc} MHz memory" : "")}");
            _ = _hunt.RunAsync(run);
            return (StatusCodes.Status200OK, "");
        }
        finally
        {
            _mutation.Release();
        }
    }

    private string? Cooldown()
    {
        var now = DateTimeOffset.UtcNow;
        var recent = _store.Current.DeviceLosses
            .Select(iso => DateTimeOffset.TryParse(iso, null, System.Globalization.DateTimeStyles.RoundtripKind, out var at) ? at : DateTimeOffset.MinValue)
            .Where(at => now - at < RepeatedLossCooldown)
            .ToList();
        if (recent.Count >= 2)
            return $"two device losses in the last minute (the last {(now - recent.Max()).TotalSeconds:0} s ago): no start for 60 s after the second, because Windows bug-checks on repeated GPU hangs";
        if (recent.Count == 1 && now - recent[0] < LossCooldown)
            return $"a device loss {(now - recent[0]).TotalSeconds:0} s ago: no start within 15 s of one";
        return null;
    }

    private static bool Running(Func<string, bool> nameMatches)
    {
        var found = false;
        foreach (var process in Process.GetProcesses())
        {
            using (process)
                found |= nameMatches(process.ProcessName);
        }
        return found;
    }

    public void RunEnded(TuneRunContext run) => _log.Write($"tune run {run.Id}: {run.State}{(run.Error is null ? "" : $": {run.Error}")}");

    public (bool Ok, string Message) Stop()
    {
        lock (_gate)
        {
            if (_run is not { State: TuneRunState.Running } run)
                return (false, "no tune run is going");
            run.Cancel.Cancel();
            return (true, "stopping: the worker is killed and the card left as found");
        }
    }

    /// <summary>Whatever of ours is on the card comes off; a crash revert is acknowledged.</summary>
    /// <summary>
    /// Hands the card back to the vendor tool (plan section 16, 'a P0 delta write replaces the
    /// vendor tool's offset'): the driver keeps our P0 deltas across a reboot, and while our
    /// route holds a delta the vendor tool's Apply lands short (the dev box read 15841 MHz
    /// against a 16037 tune, 2026-09-17). Writing 0 / 0 with nothing running clears our route;
    /// the user then applies in the vendor tool, whose write is clean again.
    /// </summary>
    /// <summary>
    /// "Keep my tune applied at startup" (plan section 16, 2026-09-17): the renderer sends the
    /// vendor values (slider units) once per collector start when the driver reads 0 / 0, so
    /// one program holds the tune. Refused while a run is going or a rung is applied, and
    /// when our route already holds something (never overwrite a value we did not just read as 0).
    /// </summary>
    public (bool Ok, string Message) Hold(PstateDeltas vendor)
    {
        if (Active) return (false, "a run is going");
        return Mutate(() =>
        {
            if (_store.Current.State == TuneRollback.Pending) return (false, "a rung is still applied");
            if (NvapiPstates.ReadDeltas(out _) is { Deltas: var now } && (now.CoreKhz != 0 || now.MemKhz != 0))
                return (false, $"our route already holds core {now.CoreKhz / 1000} / memory {now.MemKhz / 1000} MHz; nothing written");
            var deltas = VendorUnits.Deltas(vendor);
            if (!NvapiPstates.ApplyDeltas(deltas, out var status))
                return (false, $"the driver refused the tune: {status}");
            _log.Write($"tune: held at startup through our route: core +{vendor.CoreMhz} / memory +{vendor.MemMhz} slider ({status})");
            return (true, $"your tune is applied through our route: {status}");
        });
    }

    public (bool Ok, string Message) Release()
    {
        if (Active) return (false, "a run is going; stop it first");
        return Mutate(() =>
        {
            var f = _store.Current;
            if (f.State == TuneRollback.Pending) return (false, "a rung is still applied; use Revert");
            if (!NvapiPstates.ApplyDeltas(new TuneDeltas(0, 0), out var status))
                return (false, $"the driver refused 0 / 0: {status}");
            _store.Idle($"released to the vendor tool: {status}");
            _log.Write($"tune: released to the vendor tool: our P0 deltas are 0 / 0 ({status}); the user re-applies in the vendor tool");
            return (true, "our offsets are 0 / 0; apply your tune in the vendor tool now");
        });
    }

    public (bool Ok, string Message) Revert()
    {
        if (Active)
        {
            Stop();
            return (true, "the run is stopping; it restores the baseline as it ends");
        }
        return Mutate(() =>
        {
            var f = _store.Current;
            switch (f.State)
            {
                case TuneRollback.Pending when f.Baseline is { } baseline:
                    if (!NvapiPstates.ApplyDeltas(baseline, out var status))
                        return (false, $"the driver refused the baseline: {status}");
                    _store.Idle($"reverted by the user: {status}");
                    return (true, $"baseline restored: {status}");
                case TuneRollback.Pending:
                    _store.Idle("acknowledged by the user: the file had no baseline to restore, so nothing was applied (a vendor tool's offsets are left as they are)");
                    return (true, "acknowledged: the file named no baseline, so nothing was written to the card");
                case TuneRollback.Reverted:
                    _store.Idle("the crash revert is acknowledged");
                    return (true, "acknowledged; the baseline was already restored at start");
                default:
                    return (false, "nothing of Tune's is applied");
            }
        });
    }

    /// <summary>Enable records the warning's acknowledgement (plan section 27a: date, app
    /// version, GPU); disable takes anything of ours off the card first, so Tune off means
    /// nothing left behind.</summary>
    public (bool Ok, string Message) SetEnabled(TuneEnableRequest request) =>
        request.Enabled ? Mutate(() => Enable(request)) : Mutate(Disable, evenWithProblem: true);

    private (bool Ok, string Message) Enable(TuneEnableRequest request)
    {
        var gpu = _sources.NvmlSampler?.Latest.FirstOrDefault()?.Name ?? "unknown GPU";
        var note = $"Tune enabled; warning acknowledged {request.AcknowledgedAt ?? DateTimeOffset.UtcNow.ToString("O")}, app {request.AppVersion ?? "unknown"}, GPU {gpu}";
        return _store.SetEnabled(true, note)
            ? (true, "Tune enabled")
            : (false, $"the state file at {TuneStateStore.FilePath} could not be written");
    }

    // Disable works even when the file cannot be trusted, minus the apply: the flag comes
    // off, but a baseline from an untrusted file is never written to the card.
    private (bool Ok, string Message) Disable()
    {
        if (Active)
            return (false, "a run is going; stop it before disabling Tune");
        var f = _store.Current;
        if (f.State == TuneRollback.Pending && f.Baseline is { } baseline)
        {
            if (_store.Problem is { } problem)
                _log.Write($"tune: disable leaves the card as it is: the file's baseline is not trusted ({problem})");
            else if (!NvapiPstates.ApplyDeltas(baseline, out var status))
                return (false, $"cannot disable with a rung still applied: the driver refused the baseline: {status}");
            else
                _store.Idle($"reverted on disable: {status}");
        }
        _store.SetEnabled(false, "Tune disabled");
        return (true, "Tune disabled");
    }

    // Revert and SetEnabled share the start's lock and its preconditions: this collector
    // owns the state, the revert-at-start pass has attributed any crash, and (except for a
    // disable) the file can be trusted.
    private (bool Ok, string Message) Mutate(Func<(bool Ok, string Message)> action, bool evenWithProblem = false)
    {
        if (!_ownsMachine || !_reconciled)
            return (false, Problem()!);
        if (!evenWithProblem && _store.Problem is { } problem)
            return (false, problem);
        _mutation.Wait();
        try
        {
            return action();
        }
        finally
        {
            _mutation.Release();
        }
    }

    /// <summary>The value set to type into the vendor tool (plan section 16): our units,
    /// the sliders' units, the clocks it was measured from, and one line saying the card
    /// was left as found.</summary>
    public TuneExport? Export()
    {
        if (_store.Current.Result is not { } r)
            return null;
        var date = DateTimeOffset.TryParse(r.FoundAt, null, System.Globalization.DateTimeStyles.RoundtripKind, out var at) ? at.ToLocalTime().ToString("yyyy-MM-dd") : r.FoundAt[..10];
        return new TuneExport(r.Certified, VendorUnits.Slider(r.Certified), r.Vendor is { } v ? VendorUnits.Total(v, r.Certified) : null, r.BaselineHeld, r.HeldAtCertified, r.FirstFailure, ExportText(r, date), r.Confidence, r.FoundAt)
        {
            Vendor = r.Vendor,
            Score = r.Official,
            AsFound = r.AsFound,
            Rungs = r.Rungs,
            HoldsNow = r.HoldsNow,
        };
    }

    /// <summary>Mirrored in src/analysis/tune.ts exportText, where it is tested.</summary>
    public static string ExportText(TuneResult r, string date)
    {
        var c = r.Certified;
        var v = VendorUnits.Slider(c);
        // A vendor tune was reproduced through our route and climbed from; a non-zero baseline
        // without one is a tune applied by our own route (the driver reads it back); a zero
        // baseline is the card as found, stock or not.
        var found = r.Vendor is { } vendor ? $"your tune (core +{vendor.CoreMhz} / memory +{vendor.MemMhz} on the slider)"
            : r.Baseline.CoreMhz != 0 || r.Baseline.MemMhz != 0 ? $"your tune (P0 core +{r.Baseline.CoreMhz} / memory +{r.Baseline.MemMhz})"
            : "the card as found";
        var held = r.BaselineHeld is { } b && r.HeldAtCertified is { } h
            ? $"{found} holds {b.SmMhz} / {b.MemMhz}; certified +{c.CoreMhz} core / +{c.MemMhz} memory on top → {h.SmMhz} / {h.MemMhz}"
            : $"certified +{c.CoreMhz} core / +{c.MemMhz} memory on top of {found}";
        var failure = r.FirstFailure is { } f
            ? $"; first {(f.Reason == TuneStopReason.Hash ? "silent error" : f.Reason == TuneStopReason.DeviceLost ? "driver reset" : "regression")} at +{f.OffsetMhz} {f.Ladder.ToString().ToLowerInvariant()} (stage {f.Stage})"
            : "";
        var finding = c.CoreMhz == 0 && c.MemMhz == 0
            ? "Nothing above the card as found could be certified; these are not values to type anywhere."
            : "Type these into your vendor tool; Strata Tune left the card as it found it.";
        // Labelled by what the user does with each pair (the page's value set uses the same words): the whole tune to type first, the slider-unit step on top of the user's own second.
        var slider = r.Vendor is { } vt
            ? $"Type into GPU Tweak / Afterburner: core +{VendorUnits.Total(vt, c).CoreMhz}, memory +{VendorUnits.Total(vt, c).MemMhz} (your +{vt.CoreMhz} / +{vt.MemMhz} plus core +{v.CoreMhz}, memory +{v.MemMhz} on top in slider units; their memory slider counts the effective rate, twice ours)"
            : $"Type into GPU Tweak / Afterburner: core +{v.CoreMhz}, memory +{v.MemMhz} (their memory slider counts the effective rate, twice ours)";
        var left = r.Vendor is not null
            ? $"Nothing changed voltage, power limits or fans; your tune was put back through the driver's P0 offsets (core +{r.Baseline.CoreMhz} / memory +{r.Baseline.MemMhz} NVML MHz), so press Apply in the vendor tool once if it shows something else now; a driver update or a different tune means a new hunt."
            : "Nothing changed voltage, power limits or fans, and the P0 offsets are back where they were; a driver update or a different tune means a new hunt.";
        var lines = new List<string>
        {
            $"Strata Tune headroom, {date} ({r.Confidence.ToString().ToLowerInvariant()} confidence; core / memory clocks in NVML MHz under load)",
            $"{held}{failure}",
        };
        if (ScoreLine(r) is { } score)
            lines.Add(score);
        // One line per ladder stop, so a file that says "+0 core" also says why (the top of the
        // clock table, a cap, a check that stopped the ladder), not only when a stage failed.
        foreach (var stop in r.Stops)
            lines.Add($"{stop.Ladder.ToString().ToLowerInvariant()} ladder ended: {stop.Note}");
        lines.Add(slider);
        lines.Add(finding);
        lines.Add(HoldsNowLine(r));
        lines.Add(left);
        return string.Join('\n', lines);
    }

    /// <summary>"11,930 points at +45 / +60: +1.1 % over your current tune, +19 % over a
    /// reference 5090" (plan section 16); the as-found score alone when nothing above it was
    /// certified; nothing before the as-found run has scored.</summary>
    public static string? ScoreLine(TuneResult r)
    {
        if (r.AsFound?.Score is not { } found)
            return null;
        var c = r.Certified;
        if (r.Official?.Score is { } official)
            return $"{official.Points:N0} points at +{c.CoreMhz} / +{c.MemMhz}: {TuneScoring.PercentOver(official.Points, found.Points):+0.0;-0.0} % over your current tune ({found.Points:N0}), {TuneScoring.PercentOver(official.Points, TuneScoring.ReferencePoints):+0.0;-0.0} % over an estimated reference 5090 ({TuneScoring.ReferencePoints:N0}){(r.Official.SteppedDown ? "; the official run passed one fine step below the ladders' rungs" : "")}";
        return $"{found.Points:N0} points as found: {TuneScoring.PercentOver(found.Points, TuneScoring.ReferencePoints):+0.0;-0.0} % over an estimated reference 5090 ({TuneScoring.ReferencePoints:N0}){(r.Official is not null ? $"; the official run of the certified pair failed ({r.Official.Note})" : "")}";
    }

    /// <summary>Plan section 16, rule 4: what the card holds now against as found, and "re-apply
    /// in your vendor tool" when they differ by more than 1 %.</summary>
    public static string HoldsNowLine(TuneResult r)
    {
        if (r.HoldsNow is not { } now)
            return r.BaselineHeld is { } b0
                ? $"The card was not measured after the restore (the run was stopped or ended early); as found it held {b0.SmMhz} / {b0.MemMhz}: check the vendor tool shows your tune."
                : "The card was not measured after the restore; check the vendor tool shows your tune.";
        if (r.BaselineHeld is not { } b)
            return $"The card holds {now.SmMhz} / {now.MemMhz} now.";
        return TuneLadder.HoldsDiffer(b, now)
            ? $"The card holds {now.SmMhz} / {now.MemMhz} now; as found {b.SmMhz} / {b.MemMhz}: re-apply in your vendor tool."
            : $"The card holds {now.SmMhz} / {now.MemMhz} now; as found {b.SmMhz} / {b.MemMhz} (the same within 1 %).";
    }

    /// <summary>The collector is stopping, or dying: the worker dies, the baseline goes back
    /// on the card now (not when the async loop gets to it, and again if the loop's own
    /// restore failed), and a rung still pending is marked as left by an orderly stop, so
    /// the next start does not call it a hang. Idempotent, so the shutdown route,
    /// ProcessExit and an unhandled exception can all call it.</summary>
    public void Abort()
    {
        TuneRunContext? run;
        lock (_gate)
            run = _run;
        if (run is null || (run.State != TuneRunState.Running && (!run.Applied || run.Restored)))
            return;
        run.Cancel.Cancel();
        TuneHunt.KillWorker(run);
        // Before the restore, whose retries may outlast the exit deadline: the marker says
        // this exit was known about, whatever the driver then does.
        if (_reconciled && _ownsMachine)
            _store.OrderlyStop();
        _hunt.Restore(run);
        _recorder.Stop(keepFile: !run.Restored);
        FamilyGpuLock.Release();
    }
}
