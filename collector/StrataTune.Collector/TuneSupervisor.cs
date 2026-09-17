using System.Diagnostics;
using StrataTune.Shared;

namespace StrataTune.Collector;

/// <summary>The /tune/* surface: one run at a time, the refusals that keep a hunt honest
/// (plan sections 16 and 20), the keep / revert / enable transitions of the state file,
/// and the status the UI reads. The GPU work is in <see cref="TuneHunt"/>; the file is
/// <see cref="TuneStateStore"/>. Nothing here runs unless Tune is enabled on both sides:
/// the UI's setting arrives with the start request and the state file keeps its own flag.
/// Every mutation (start, keep, revert, enable) goes through one async lock and waits for
/// the start-of-session pass, so a keep cannot land between a start's checks and its
/// baseline read, and nothing acts on a crash before it has been attributed.</summary>
internal sealed class TuneSupervisor
{
    public const int Conflict = StatusCodes.Status409Conflict, BadRequest = StatusCodes.Status400BadRequest, Forbidden = StatusCodes.Status403Forbidden;
    private const int IdLength = 12;
    // The vendor tools re-apply their profiles on timers and would fight a hunt for the
    // same NVAPI call; the bench and a capture load the GPU; another worker is a load run.
    private static readonly string[] VendorTools = ["GPU Tweak III", "GPUTweakIII", "MSIAfterburner"];
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

    /// <summary>The start-of-session pass: a crash is reverted and its flight file kept, a
    /// kept result that survived a clean boot is promoted, the logon task is brought in line
    /// with the flag and this exe's location, and the session is marked as running so a
    /// crash from here on is recognised next time.</summary>
    public void Reconcile()
    {
        var before = _store.Current;
        if (!_ownsMachine)
        {
            _log.Write("tune: start-of-session pass skipped: another collector owns the state");
            _reconciled = true;
            return;
        }
        if (!TuneStateMachine.Reconcile(_store, _log.Write, out var outcome))
            _log.Write($"tune: state {outcome} could not be reverted at start; the logon task will retry");
        if (_store.Current.State == TuneRollback.Reverted && before.State != TuneRollback.Reverted)
            FlightRecorder.KeepLastCrash(_log.Write);
        _store.MarkRunning();
        RevertTask.Reconcile(_store.Current.Enabled, _log.Write);
        _reconciled = true;
        var deltas = NvapiPstates.ReadDeltas(out var failure);
        _log.Write(deltas is null
            ? $"tune: NVAPI pstates unavailable: {failure}"
            : $"tune: NVAPI P0 deltas core {deltas.Deltas.CoreKhz / 1000} / memory {deltas.Deltas.MemKhz / 1000} MHz (range core {deltas.CoreMinKhz / 1000}..{deltas.CoreMaxKhz / 1000}, memory {deltas.MemMinKhz / 1000}..{deltas.MemMaxKhz / 1000}, editable {deltas.Editable}, {NvapiPstates.GpuCount} GPU(s)), state {_store.Current.State.Wire()}");
        // The offsets do not survive a boot: a baseline the file remembers from before one
        // is not what the card holds now, and the strip would show a value the card lacks.
        if (deltas is not null && _store.Current.State == TuneRollback.KnownGood && _store.Current.Baseline is { } remembered && remembered != deltas.Deltas)
            _store.Baseline(deltas.Deltas, $"baseline re-read from the card at start: the driver holds core {deltas.Deltas.CoreKhz / 1000} / memory {deltas.Deltas.MemKhz / 1000} MHz, the file remembered {remembered.CoreKhz / 1000} / {remembered.MemKhz / 1000} (offsets do not survive a reboot)");
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
        return new TuneStatus(f.Enabled, f.State, f.Baseline, f.Candidate, f.AppliedAt, f.LastCleanShutdown, f.Reverted, f.Result, f.History,
            new TuneNvapi(range is not null, failure, range?.Deltas, range), Run(), RevertTask.IsRegistered(), FlightRecorder.HasLastCrash, TuneStateStore.FilePath)
        {
            RevertTaskProblem = RevertTask.Problem,
            Problem = Problem(),
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
        : !_reconciled ? "the start-of-session pass has not run yet"
        : _store.Problem;

    public async Task<(int Status, string Refusal)> TryStartAsync(TuneStartRequest request)
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
        var state = _store.Current.State;
        if (state == TuneRollback.Validating)
            return (Conflict, "a kept result is on the card: revert it, or reboot once so a clean boot promotes it, before another run");
        if (state == TuneRollback.Pending)
            return (Conflict, "the state file says a candidate is still applied and could not be reverted; POST /tune/revert first");
        if (Cooldown() is { } cooling)
            return (Conflict, cooling);
        if (FamilyGpuLock.HeldBy() is { } holder)
            return (Conflict, holder);
        if (VendorToolRunning() is { } tool)
            return (Conflict, $"{tool} is running; its profile timers would fight the hunt for the same clock offsets. Close it for the run (its settings stay applied)");
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
                if (_store.Current.State is TuneRollback.Validating or TuneRollback.Pending)
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
                    _store.KnownGood("a new run starts: the last crash's revert is acknowledged");
                run = new TuneRunContext(Guid.NewGuid().ToString("N")[..IdLength], request.EffectiveKind) { MaxCandidates = request.MaxCandidates is > 0 and var cap ? cap : null };
                _run = run;
            }
            _log.Write($"tune run {run.Id}: {run.Kind} start requested");
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

    private static string? VendorToolRunning()
    {
        foreach (var name in VendorTools)
            if (Running(p => string.Equals(p, name, StringComparison.OrdinalIgnoreCase)))
                return name;
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
            return (true, "stopping: the worker is killed and the baseline restored");
        }
    }

    /// <summary>Puts a validated result on the card and leaves it there as VALIDATING until
    /// the next boot; a clean shutdown and a clean boot promote it (<see cref="TuneStateMachine"/>).
    /// The offsets are not re-applied after that boot: the export text is what persists.</summary>
    public (bool Ok, string Message) Keep() => Mutate(() =>
    {
        if (Active)
            return (false, "a run is going; wait for it to end");
        var f = _store.Current;
        if (!f.Enabled)
            return (false, "Tune is not enabled: turn it on in Settings first");
        if (f.State != TuneRollback.KnownGood)
            return (false, $"the state is {f.State}, not KNOWN_GOOD");
        if (f.Result is not { Validated: true } result)
            return (false, "no validated result: run a hunt, then a validate run, first");
        if (result.Baseline != f.Baseline)
            return (false, "the result was measured from a different baseline than the card runs now; run the hunt again");
        if (VendorToolRunning() is { } tool)
            return (false, $"{tool} is running; its profile timers would overwrite the kept offsets. Close it first");
        if (!_store.Pending(result.Deltas, "keeping the validated result"))
            return (false, $"the state file at {TuneStateStore.FilePath} could not be written; nothing was applied");
        if (!NvapiPstates.ApplyDeltas(result.Deltas, out var status))
        {
            NvapiPstates.ApplyDeltas(f.Baseline!, out var restore);
            _store.KnownGood($"keep failed ({status}); baseline re-applied: {restore}");
            return (false, $"the driver refused the result: {status}");
        }
        _store.Validating(result.Deltas, $"kept: {status}. On the card until the next boot; a clean shutdown and a clean boot promote it to known-good");
        return (true, "the result is on the card until the next boot; a clean shutdown and a clean boot make it the known-good (the offsets are not re-applied after that: the export text is what persists)");
    });

    /// <summary>Whatever of ours is on the card comes off; a crash revert is acknowledged.</summary>
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
                case TuneRollback.Validating or TuneRollback.Pending when f.Baseline is { } baseline:
                    if (!NvapiPstates.ApplyDeltas(baseline, out var status))
                        return (false, $"the driver refused the baseline: {status}");
                    _store.KnownGood($"reverted by the user: {status}");
                    return (true, $"baseline restored: {status}");
                case TuneRollback.Validating or TuneRollback.Pending:
                    _store.KnownGood("acknowledged by the user: the file had no baseline to restore, so nothing was applied (a vendor tool's offsets are left as they are)");
                    return (true, "acknowledged: the file named no baseline, so nothing was written to the card");
                case TuneRollback.Reverted:
                    _store.KnownGood("the crash revert is acknowledged");
                    return (true, "acknowledged; the baseline was already restored at start");
                default:
                    return (false, "nothing of Tune's is applied");
            }
        });
    }

    /// <summary>Enable records the warning's acknowledgement (plan section 27a: date, app
    /// version, GPU) and registers the logon revert task; disable takes anything of ours off
    /// the card first, then removes the task, so Tune off means nothing left behind.</summary>
    public (bool Ok, string Message) SetEnabled(TuneEnableRequest request) =>
        request.Enabled ? Mutate(() => Enable(request)) : Mutate(Disable, evenWithProblem: true);

    private (bool Ok, string Message) Enable(TuneEnableRequest request)
    {
        var gpu = _sources.NvmlSampler?.Latest.FirstOrDefault()?.Name ?? "unknown GPU";
        var note = $"Tune enabled; warning acknowledged {request.AcknowledgedAt ?? DateTimeOffset.UtcNow.ToString("O")}, app {request.AppVersion ?? "unknown"}, GPU {gpu}";
        if (!_store.SetEnabled(true, note))
            return (false, $"the state file at {TuneStateStore.FilePath} could not be written");
        var registered = RevertTask.Register(_log.Write);
        return (true, registered
            ? "Tune enabled; the logon revert task is registered"
            : $"Tune enabled, but {RevertTask.Problem ?? "the logon revert task could not be registered"}; a hard hang is reverted only at the next app start");
    }

    // Disable works even when the file cannot be trusted, minus the apply: the flag comes
    // off and the task goes, but a baseline from an untrusted file is never written to the card.
    private (bool Ok, string Message) Disable()
    {
        if (Active)
            return (false, "a run is going; stop it before disabling Tune");
        var f = _store.Current;
        if (f.State is TuneRollback.Validating or TuneRollback.Pending && f.Baseline is { } baseline)
        {
            if (_store.Problem is { } problem)
                _log.Write($"tune: disable leaves the card as it is: the file's baseline is not trusted ({problem})");
            else if (!NvapiPstates.ApplyDeltas(baseline, out var status))
                return (false, $"cannot disable with a result still applied: the driver refused the baseline: {status}");
            else
                _store.KnownGood($"reverted on disable: {status}");
        }
        _store.SetEnabled(false, "Tune disabled");
        var removed = RevertTask.Remove(_log.Write);
        return (true, removed ? "Tune disabled; the logon revert task is removed" : "Tune disabled, but the logon revert task could not be removed (schtasks failed); it is harmless with nothing pending");
    }

    // Keep, Revert and SetEnabled share the start's lock and its preconditions: this
    // collector owns the state, the start-of-session pass has attributed any crash, and
    // (except for a disable) the file can be trusted.
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

    /// <summary>The copy-pasteable Afterburner / GPU Tweak value set (plan section 16).</summary>
    public TuneExport? Export()
    {
        if (_store.Current.Result is not { } r)
            return null;
        var core = r.Deltas.CoreKhz / 1000;
        var mem = r.Deltas.MemKhz / 1000;
        var baseline = new PstateDeltas(r.Baseline.CoreKhz / 1000, r.Baseline.MemKhz / 1000);
        var date = DateTimeOffset.TryParse(r.FoundAt, null, System.Globalization.DateTimeStyles.RoundtripKind, out var at) ? at.ToLocalTime().ToString("yyyy-MM-dd") : r.FoundAt[..10];
        var certified = r.Promoted ? ", validated 5 min heavy + 2 min transient, and kept through a clean shutdown and a clean boot"
            : r.Validated ? $", validated 5 min heavy + 2 min transient{(r.ThrottledFraction is > TuneLadder.ThrottledFractionLimit and var t ? $" (power- or thermal-limited {t:P0} of the time at your fan curve)" : "")}"
            : ", not yet validated";
        var clocks = r.ReferenceSmMhz is { } sm && r.ReferenceMemMhz is { } mm
            ? $"Measured with the card at core {sm} / memory {mm} MHz under load with nothing of Strata Tune's applied; an OC a vendor tool applies by another route (VF points) is inside those clocks, not in the baseline above."
            : "The clocks under load during the reference run were not recorded.";
        var text = $"""
            Strata Tune {r.Kind} result, {date} ({r.Confidence} confidence{certified})
              GPU core clock offset:    {core:+0;-0;+0} MHz
              Memory clock offset:      {mem:+0;-0;+0} MHz
            {(r.Deltas == r.Baseline ? "No rung above the baseline could be certified, so these are the baseline values, not a finding." : "These are absolute offsets to type into MSI Afterburner or ASUS GPU Tweak III.")}
            They were measured from a baseline of core {baseline.CoreMhz:+0;-0;+0} / memory {baseline.MemMhz:+0;-0;+0} MHz (the P0 offsets the driver reported when the hunt started); a different baseline or a driver update means a new hunt.
            {clocks}
            Fans were on your own curve throughout: Strata Tune does not control them. Offsets applied by Strata Tune do not survive a reboot; this text is what persists.
            """;
        return new TuneExport(core, mem, baseline, text, r.Validated, r.Confidence, r.FoundAt);
    }

    /// <summary>The collector is stopping, or dying: the worker dies, the baseline goes back
    /// on the card now (not when the async loop gets to it, and again if the loop's own
    /// restore failed), and the file records a clean exit. Idempotent, so the shutdown
    /// route, ProcessExit and an unhandled exception can all call it.</summary>
    public void Abort()
    {
        TuneRunContext? run;
        lock (_gate)
            run = _run;
        if (run is not null && (run.State == TuneRunState.Running || (run.Applied && !run.Restored)))
        {
            run.Cancel.Cancel();
            TuneHunt.KillWorker(run);
            _hunt.Restore(run);
            _recorder.Stop(keepFile: !run.Restored);
            FamilyGpuLock.Release();
        }
        // A quit before the start-of-session pass ran must not turn a crash's VALIDATING into
        // a clean one: the next start would promote the candidate that took the machine down.
        // A collector that does not own the state never writes the file at all.
        if (_reconciled && _ownsMachine)
            _store.MarkCleanShutdown();
    }
}
