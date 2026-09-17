using System.Text.Json;
using StrataTune.Shared;

namespace StrataTune.Collector;

/// <summary>Plan section 16's rollback state machine, persisted to
/// %ProgramData%\Strata Tune\tune-state.json. The rule that matters: the file says PENDING
/// with the candidate <em>before</em> the driver is asked to apply it, so whatever the
/// machine does next, the next start (or the logon task) knows exactly what was on the
/// card. Every write is a temp file and a rename, and every writer learns whether the disk
/// took it, because a candidate must never reach the card while the disk still says
/// KNOWN_GOOD. The folder is created with an ACL that lets standard users read but only
/// administrators write, and the ACL is checked and repaired at every start (an installer,
/// an older build or a standard user may have created it first), because an elevated
/// process acting on this file must not be steerable from medium integrity.</summary>
internal sealed class TuneStateStore
{
    public const string FolderName = "Strata Tune";
    private const int KeepHistory = 50, KeepDeviceLosses = 10;

    public static readonly string Root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), FolderName);
    public static readonly string FilePath = Path.Combine(Root, "tune-state.json");
    private static readonly string BadCopyPath = FilePath + ".bad";

    private static readonly TuneFile Empty = new(false, TuneRollback.KnownGood, null, null, null, false, null, null, null, []);
    private static ReadOnlySpan<byte> Utf8Bom => [0xEF, 0xBB, 0xBF];

    private readonly Lock _gate = new();
    private readonly Action<string> _log;
    private TuneFile _file;

    public TuneStateStore(Action<string> log)
    {
        _log = log;
        AclProblem = AdminOnly.EnforceFolder(Root, FilePath, log);
        if (AclProblem is not null)
            log($"tune: the state folder is not administrator-only and could not be made so: {AclProblem}; Tune refuses to trust the file");
        _file = Load(out var unreadable) ?? Empty;
        FileProblem = unreadable;
        if (unreadable is not null)
            log($"tune: {unreadable}");
    }

    /// <summary>Set when the folder or the file is writable by someone other than
    /// administrators and the repair failed: nothing in the file may then steer a write.</summary>
    public string? AclProblem { get; }

    /// <summary>Set when a file existed but did not parse; it was copied beside itself as
    /// .bad so the PENDING it may have held is not silently forgotten.</summary>
    public string? FileProblem { get; }

    public string? Problem => AclProblem ?? FileProblem;

    public TuneFile Current
    {
        get { lock (_gate) return _file; }
    }

    /// <summary>The file as written, or null when there is none or it does not parse. A
    /// corrupt file is treated as no state (nothing of ours is known to be applied, the
    /// only safe reading of a file we cannot trust), kept as .bad and reported. A UTF-8
    /// byte-order mark (an editor's, never ours) is skipped: the file is meant to be read
    /// by people, and one who edits it must not lose a PENDING to the first three bytes.</summary>
    public static TuneFile? Load(out string? unreadable)
    {
        unreadable = null;
        try
        {
            if (!File.Exists(FilePath))
                return null;
            ReadOnlySpan<byte> bytes = File.ReadAllBytes(FilePath);
            if (bytes.StartsWith(Utf8Bom))
                bytes = bytes[Utf8Bom.Length..];
            return JsonSerializer.Deserialize(bytes, WireJson.Default.TuneFile);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException)
        {
            unreadable = $"state file unreadable ({e.GetType().Name}: {e.Message}); a copy is kept at {BadCopyPath}";
            try
            {
                File.Copy(FilePath, BadCopyPath, overwrite: true);
            }
            catch (Exception copy) when (copy is IOException or UnauthorizedAccessException)
            {
                unreadable = $"state file unreadable ({e.GetType().Name}: {e.Message}); it could not be copied aside either";
            }
            return null;
        }
    }

    public bool SetEnabled(bool enabled, string note) => Update(f => f with { Enabled = enabled }, note);

    /// <summary>Called before ApplyDeltas, never after: the disk must say PENDING while the
    /// driver call is in flight. False means the disk did not take it and the caller must
    /// not touch the driver.</summary>
    public bool Pending(TuneDeltas candidate, string note) => Update(f => f with
    {
        State = TuneRollback.Pending,
        Candidate = candidate,
        AppliedAt = Now(),
        BootAt = BootRecord.BootedAtIso,
    }, note, candidate);

    public bool KnownGood(string note) => Update(f => f with { State = TuneRollback.KnownGood, Candidate = null }, note);

    public bool Validating(TuneDeltas candidate, string note) => Update(f => f with
    {
        State = TuneRollback.Validating,
        Candidate = candidate,
        AppliedAt = Now(),
        BootAt = BootRecord.BootedAtIso,
    }, note, candidate);

    public bool Reverted(TuneReverted reverted) => Update(f => f with
    {
        State = TuneRollback.Reverted,
        Candidate = null,
        Reverted = reverted,
    }, $"reverted to baseline: {reverted.Reason}", reverted.Candidate);

    public bool Baseline(TuneDeltas baseline, string note) => Update(f => f with { Baseline = baseline }, note);

    public bool Result(TuneResult result) => Update(f => f with { Result = result }, $"result: core {result.Deltas.CoreKhz / 1000} MHz, memory {result.Deltas.MemKhz / 1000} MHz, {result.Confidence} confidence{(result.Validated ? ", validated" : "")}{(result.Promoted ? ", promoted" : "")}");

    /// <summary>A device loss, remembered across runs and collector restarts for the start cooldown.</summary>
    public bool DeviceLost() => Update(f => f with { DeviceLosses = [.. f.DeviceLosses.TakeLast(KeepDeviceLosses - 1), Now()] }, null);

    /// <summary>The start of a session: whatever the last one left, this one has not shut down cleanly yet.</summary>
    public bool MarkRunning() => Update(f => f with { CleanShutdown = false, BootAt = BootRecord.BootedAtIso }, null);

    /// <summary>The orderly exit. Only an exit that went through here counts; a crash never reaches it.</summary>
    public bool MarkCleanShutdown() => Update(f => f with { CleanShutdown = true, LastCleanShutdown = Now(), BootAt = BootRecord.BootedAtIso }, null);

    private bool Update(Func<TuneFile, TuneFile> change, string? note, TuneDeltas? candidate = null)
    {
        lock (_gate)
        {
            var next = change(_file);
            if (note is not null)
            {
                var history = new List<TuneHistoryEntry>(next.History) { new(Now(), next.State, candidate, note) };
                if (history.Count > KeepHistory)
                    history.RemoveRange(0, history.Count - KeepHistory);
                next = next with { History = history };
                _log($"tune state {next.State.Wire()}: {note}");
            }
            if (!Save(next, _log))
                return false;
            _file = next;
            return true;
        }
    }

    public static bool Save(TuneFile file, Action<string> log)
    {
        try
        {
            EnsureRoot();
            var temp = $"{FilePath}.{Environment.ProcessId}.tmp";
            File.WriteAllBytes(temp, JsonSerializer.SerializeToUtf8Bytes(file, WireJson.Default.TuneFile));
            File.Move(temp, FilePath, overwrite: true);
            return true;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            log($"tune state NOT saved to {FilePath}: {e.Message}");
            return false;
        }
    }

    // Administrators and SYSTEM write, everyone reads; inheritance from %ProgramData% (which
    // lets Users create files) is cut, since a user-writable state file would let a
    // standard user tell the logon revert task which values to apply as administrator.
    private static void EnsureRoot()
    {
        if (!Directory.Exists(Root))
            new DirectoryInfo(Root).Create(AdminOnly.Restricted());
    }

    private static string Now() => DateTimeOffset.UtcNow.ToString("O");
}

internal static class TuneRollbackSpelling
{
    /// <summary>The wire spelling, for log lines and console output that a person reads beside the JSON.</summary>
    public static string Wire(this TuneRollback state) => state switch
    {
        TuneRollback.KnownGood => "KNOWN_GOOD",
        TuneRollback.Pending => "PENDING",
        TuneRollback.Validating => "VALIDATING",
        _ => "REVERTED",
    };
}

/// <summary>What a start knows beyond the file: whether this is the boot the file was
/// written in, whether Windows logged a dirty shutdown since the value went on the card
/// (null: the log could not be asked), and whether the card still holds the candidate
/// (null: NVAPI could not read it).</summary>
internal sealed record StartFacts(bool SameBoot, bool? UnexpectedShutdown, bool? OnCard);

/// <summary>What a start (the collector's, or the logon task's) does with the file it
/// finds. Pure, so the TypeScript side can mirror and test the same table:
/// PENDING → revert (a run that never finished, clean shutdown or not: a candidate that
/// reached a start was never certified); VALIDATING without a clean shutdown → revert (the
/// machine died with a kept result applied); VALIDATING in the same boot → nothing (it is
/// still on the card, or the driver dropped it, in which case → forget); VALIDATING from a
/// later boot → promote only when the shutdown was clean <em>and</em> the System log shows
/// no dirty shutdown since it was applied, else → revert; a log that could not be asked →
/// forget (neither blamed nor certified). Promotion never touches the baseline: the P0
/// deltas did not survive the boot, so the card is back at whatever it boots with.</summary>
internal static class TuneStateMachine
{
    public enum StartAction { None, Revert, Promote, Forget }

    public static (StartAction Action, string Reason) AtStart(TuneFile file, StartFacts facts) => file.State switch
    {
        TuneRollback.Pending when file.Candidate is null => (StartAction.None, "PENDING without a candidate: nothing was applied"),
        TuneRollback.Pending => (StartAction.Revert, file.CleanShutdown
            ? "a hunt was applying this candidate when the collector last exited; the run never finished"
            : "the machine did not shut down cleanly while this candidate was applied (a hard hang, stage 4)"),
        TuneRollback.Validating when file.Candidate is null => (StartAction.None, "VALIDATING without a candidate: nothing was applied"),
        TuneRollback.Validating when !file.CleanShutdown => (StartAction.Revert, "the machine did not shut down cleanly while this kept result was applied"),
        TuneRollback.Validating when facts.SameBoot => facts.OnCard == false
            ? (StartAction.Forget, "the driver no longer holds the kept result (a driver reset or reload took it off); nothing is promoted")
            : (StartAction.None, "the kept result is on the card until this boot ends; a clean boot after a clean shutdown promotes it"),
        TuneRollback.Validating => facts.UnexpectedShutdown switch
        {
            true => (StartAction.Revert, "the System log records a dirty shutdown (Kernel-Power 41 / EventLog 6008) after this kept result went on the card"),
            false => (StartAction.Promote, "a clean shutdown, no dirty shutdown in the System log, and a new boot: the kept result is known-good"),
            null => (StartAction.Forget, "the System log could not be checked, so the kept result is neither blamed nor certified"),
        },
        _ => (StartAction.None, "nothing pending"),
    };

    /// <summary>Runs <see cref="AtStart"/> and acts on it: the revert goes through NVAPI and
    /// is recorded with the candidate that caused it (plan section 16: tell the user exactly
    /// which value did it). Returns false only when a revert was needed and could not be
    /// done, which is the one outcome that must not look like success.</summary>
    public static bool Reconcile(TuneStateStore store, Action<string> log, out TuneRollback outcome)
    {
        var file = store.Current;
        outcome = file.State;
        if (store.Problem is { } problem && file.State is TuneRollback.Pending or TuneRollback.Validating)
        {
            log($"tune: {file.State.Wire()} found at start but the file cannot be trusted ({problem}); nothing is applied from it");
            return false;
        }
        var facts = Facts(file, log);
        var (action, reason) = AtStart(file, facts);
        switch (action)
        {
            case StartAction.Revert:
                if (file.Baseline is not { } baseline)
                {
                    // Applying 0/0 would wipe a vendor tool's offsets; leave it, and say so every start.
                    log($"tune: {file.State.Wire()} found at start without a baseline; refusing to guess one (the user's Revert acknowledges it)");
                    return false;
                }
                log($"tune: {file.State.Wire()} found at start with candidate core {file.Candidate!.CoreKhz} / memory {file.Candidate.MemKhz} kHz: {reason}; reverting to baseline core {baseline.CoreKhz} / memory {baseline.MemKhz} kHz");
                var ok = NvapiPstates.ApplyDeltas(baseline, out var status);
                log($"tune: revert {(ok ? "applied" : "FAILED")}: {status}");
                if (!ok)
                    return false;
                store.Reverted(new TuneReverted(file.Candidate, baseline, DateTimeOffset.UtcNow.ToString("O"), reason));
                break;
            case StartAction.Promote:
                log($"tune: promoting kept result core {file.Candidate!.CoreKhz} / memory {file.Candidate.MemKhz} kHz: {reason}");
                if (file.Result is { } result)
                    store.Result(result with { Validated = true, Promoted = true });
                store.KnownGood("promoted to KNOWN_GOOD: kept through a clean shutdown and a clean boot. The offsets are not re-applied; the export text is what persists");
                break;
            case StartAction.Forget:
                log($"tune: kept result core {file.Candidate!.CoreKhz} / memory {file.Candidate.MemKhz} kHz dropped: {reason}");
                store.KnownGood($"kept result dropped: {reason}");
                break;
            default:
                if (file.State is TuneRollback.Validating)
                    log($"tune: VALIDATING kept: {reason}");
                break;
        }
        outcome = store.Current.State;
        return true;
    }

    private static StartFacts Facts(TuneFile file, Action<string> log)
    {
        if (file.State != TuneRollback.Validating || file.Candidate is null || !file.CleanShutdown)
            return new StartFacts(true, null, null);
        var sameBoot = BootRecord.SameBoot(file.BootAt);
        var onCard = NvapiPstates.ReadDeltas(out _) is { } range ? range.Deltas == file.Candidate : (bool?)null;
        var dirty = sameBoot || file.AppliedAt is null ? null : BootRecord.UnexpectedShutdownSince(file.AppliedAt, log);
        log($"tune: start facts: same boot {sameBoot} (file boot {file.BootAt ?? "-"}, this boot {BootRecord.BootedAtIso}), on card {onCard?.ToString() ?? "unknown"}, dirty shutdown since apply {dirty?.ToString() ?? "unknown"}");
        return new StartFacts(sameBoot, dirty, onCard);
    }
}
