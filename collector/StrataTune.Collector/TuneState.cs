using System.Text;
using System.Text.Json;
using StrataTune.Shared;

namespace StrataTune.Collector;

/// <summary>Plan section 16's state machine, persisted to
/// %ProgramData%\Strata Tune\tune-state.json. The rule that matters: the file says PENDING
/// with the rung <em>before</em> the driver is asked to apply it, so whatever the
/// machine does next, the next start knows exactly what was on the card. Every write is a
/// temp file and a rename, and every writer learns whether the disk took it, because a
/// rung must never reach the card while the disk still says IDLE. The folder is created
/// with an ACL that lets standard users read but only administrators write, and the ACL is
/// checked and repaired at every start (an installer, an older build or a standard user
/// may have created it first), because the elevated collector applies the baseline this
/// file names, and that must not be steerable from medium integrity.</summary>
internal sealed class TuneStateStore
{
    public const string FolderName = "Strata Tune";
    private const int KeepHistory = 50, KeepDeviceLosses = 10;

    public static readonly string Root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), FolderName);
    public static readonly string FilePath = Path.Combine(Root, "tune-state.json");
    private static readonly string BadCopyPath = FilePath + ".bad";

    private static readonly TuneFile Empty = new(false, TuneRollback.Idle, null, null, null, false, null, null, []);
    private static ReadOnlySpan<byte> Utf8Bom => [0xEF, 0xBB, 0xBF];
    // The Phase 8 build spelled the idle state KNOWN_GOOD and kept a result on the card as
    // VALIDATING; a file it wrote is read as IDLE, and a kept result as PENDING so the
    // start takes it off the card (the fields that build kept are skipped by the parser).
    private static readonly (string From, string To)[] LegacySpellings = [("\"KNOWN_GOOD\"", "\"IDLE\""), ("\"VALIDATING\"", "\"PENDING\"")];

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
            var text = Encoding.UTF8.GetString(bytes);
            foreach (var (from, to) in LegacySpellings)
                text = text.Replace(from, to);
            var file = JsonSerializer.Deserialize(text, WireJson.Default.TuneFile);
            // A list written as null (an older build's file, a hand-edited one) reads as empty:
            // the start cooldown and the result's stops must never trip over it.
            return file is null ? null : file with
            {
                History = file.History ?? [],
                DeviceLosses = file.DeviceLosses ?? [],
                Result = file.Result is { } r ? r with { Stops = r.Stops ?? [], Rungs = r.Rungs ?? [] } : null,
            };
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
        OrderlyStop = false,
    }, note, candidate);

    public bool Idle(string note) => Update(f => f with { State = TuneRollback.Idle, Candidate = null, OrderlyStop = false }, note);

    public bool Reverted(TuneReverted reverted) => Update(f => f with
    {
        State = TuneRollback.Reverted,
        Candidate = null,
        OrderlyStop = false,
        Reverted = reverted,
    }, $"reverted to baseline: {reverted.Reason}", reverted.Candidate);

    /// <summary>The collector is exiting through a known path with a rung still PENDING:
    /// whatever its restore manages in the seconds it has, the next start must not call
    /// this a hang.</summary>
    public bool OrderlyStop() => Update(f => f.State == TuneRollback.Pending ? f with { OrderlyStop = true } : f, null);

    /// <summary>The revert target, with the vendor tool's values it reproduces (slider units)
    /// when it is the user's tune written through our route, so the revert at the next
    /// start restores the tune and says so, never 0 (plan section 16, rule 1).</summary>
    public bool Baseline(TuneDeltas baseline, PstateDeltas? vendor, string note) => Update(f => f with { Baseline = baseline, Vendor = vendor }, note);

    public bool Result(TuneResult result) => Update(f => f with { Result = result }, $"result: certified +{result.Certified.CoreMhz} core / +{result.Certified.MemMhz} memory MHz on top of the card as found, {result.Confidence} confidence");

    /// <summary>A device loss, remembered across runs and collector restarts for the start cooldown.</summary>
    public bool DeviceLost() => Update(f => f with { DeviceLosses = [.. f.DeviceLosses.TakeLast(KeepDeviceLosses - 1), Now()] }, null);

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
    // standard user tell the elevated collector which baseline to apply at its next start.
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
        TuneRollback.Idle => "IDLE",
        TuneRollback.Pending => "PENDING",
        _ => "REVERTED",
    };
}

/// <summary>What a start does with the file it finds. Pure, so the TypeScript side can
/// mirror and test the same table: PENDING with a rung → revert (a rung that reached a
/// start was never certified), called a hard hang (stage 4, the flight file kept) unless
/// the collector marked its exit path on the way out; anything else → nothing. A reboot
/// clears P0 deltas by itself, so the revert is only for a collector that died without
/// the machine going down.</summary>
internal static class TuneStateMachine
{
    public enum StartAction { None, Revert }

    public static (StartAction Action, bool Hang, string Reason) AtStart(TuneFile file) => file.State switch
    {
        TuneRollback.Pending when file.Candidate is null => (StartAction.None, false, "PENDING without a rung: nothing was applied"),
        TuneRollback.Pending when file.OrderlyStop => (StartAction.Revert, false, "the collector reached its exit path with this rung still applied and could not take it off on the way out; reverting quietly"),
        TuneRollback.Pending => (StartAction.Revert, true, "the machine or the collector died with this rung applied, without reaching the exit path (a hard hang, stage 4)"),
        _ => (StartAction.None, false, "nothing pending"),
    };

    /// <summary>Runs <see cref="AtStart"/> and acts on it: the revert goes through NVAPI and,
    /// for a hang, is recorded with the rung that caused it (plan section 16: tell the user
    /// exactly which value did it). Returns false only when a revert was needed and could
    /// not be done, which is the one outcome that must not look like success.</summary>
    public static bool Reconcile(TuneStateStore store, Action<string> log, out TuneRollback outcome)
    {
        var file = store.Current;
        outcome = file.State;
        if (store.Problem is { } problem && file.State == TuneRollback.Pending)
        {
            log($"tune: PENDING found at start but the file cannot be trusted ({problem}); nothing is applied from it");
            return false;
        }
        var (action, hang, reason) = AtStart(file);
        if (action == StartAction.None)
            return true;
        if (file.Baseline is not { } baseline)
        {
            // Applying 0/0 would wipe a vendor tool's offsets; leave it, and say so every start.
            log("tune: PENDING found at start without a baseline; refusing to guess one (the user's Revert acknowledges it)");
            return false;
        }
        var target = file.Vendor is { } v
            ? $"your vendor tune through our route, P0 core +{baseline.CoreMhz} / memory +{baseline.MemMhz} MHz (the tool shows core +{v.CoreMhz} / memory +{v.MemMhz}), never 0"
            : $"baseline core {baseline.CoreMhz} / memory {baseline.MemMhz} MHz";
        log($"tune: PENDING found at start with rung core {file.Candidate!.CoreMhz} / memory {file.Candidate.MemMhz} MHz: {reason}; reverting to {target}");
        var ok = NvapiPstates.ApplyDeltas(baseline, out var status);
        log($"tune: revert {(ok ? "applied" : "FAILED")}: {status}");
        if (!ok)
            return false;
        if (hang)
            store.Reverted(new TuneReverted(file.Candidate, baseline, DateTimeOffset.UtcNow.ToString("O"), reason, 4));
        else
            store.Idle($"reverted at start: {reason}");
        outcome = store.Current.State;
        return true;
    }
}
