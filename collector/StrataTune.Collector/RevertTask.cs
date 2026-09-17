using System.Diagnostics;
using System.Security;
using System.Text;

namespace StrataTune.Collector;

/// <summary>The logon safety net (plan section 16): a Task Scheduler entry that runs
/// <c>strata-tune-collector.exe --revert-if-pending</c> elevated at every logon, so a
/// candidate left on the card by a hard hang is put back even if the user never opens the
/// app again. Registered when Tune is enabled, removed when it is disabled. The task names
/// this exe by its full path, which is why the install-location rule in collector/README.md
/// matters twice here: a user-writable exe path would run a standard user's code as
/// administrator at every logon, so <see cref="AdminOnly.ExeProblem"/> is the gate and a
/// task that fails it is removed rather than left. The task is defined in XML rather than
/// by /SC ONLOGON flags because the flags leave the scheduler's laptop defaults (no start
/// on battery, stop when going on battery) and bind the trigger and the principal to the
/// one account that elevated the collector; the definition below runs as SYSTEM at any
/// user's logon, on battery too, and gives up after two minutes.</summary>
internal static class RevertTask
{
    public const string Name = "Strata Tune revert-if-pending";
    public const string Verb = "--revert-if-pending";
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(15);
    private static readonly string DefinitionPath = Path.Combine(TuneStateStore.Root, "revert-task.xml");

    // /tune/state asks on every read; schtasks is a process launch, so the answer is kept
    // for a while and refreshed the moment this class changes it.
    private static readonly TimeSpan QueryCache = TimeSpan.FromSeconds(30);
    private static readonly Lock Gate = new();
    private static bool? _registered;
    private static DateTimeOffset _queriedAt = DateTimeOffset.MinValue;
    private static string? _problem;

    public static string Exe => Environment.ProcessPath ?? Path.Combine(AppContext.BaseDirectory, "strata-tune-collector.exe");

    /// <summary>Why the task is not (or must not be) registered, for /tune/state; null when it is fine.</summary>
    public static string? Problem
    {
        get { lock (Gate) return _problem; }
    }

    public static bool IsRegistered()
    {
        lock (Gate)
        {
            if (_registered is null || DateTimeOffset.UtcNow - _queriedAt > QueryCache)
            {
                _registered = Run("/Query", "/TN", Name) == 0;
                _queriedAt = DateTimeOffset.UtcNow;
            }
            return _registered.Value;
        }
    }

    /// <summary>Creates or replaces the task (/F). False, with the reason kept for
    /// /tune/state, when this exe's location fails the admin-only rule or schtasks fails.</summary>
    public static bool Register(Action<string> log)
    {
        var exe = Exe;
        if (AdminOnly.ExeProblem(exe) is { } unsafeLocation)
        {
            var problem = $"the logon revert task is refused: {unsafeLocation}. An elevated task must only run an exe that administrators alone can write (Program Files, or ProgramData with a restricted ACL)";
            lock (Gate)
                _problem = problem;
            log($"tune: {problem}");
            return false;
        }
        int rc;
        try
        {
            Directory.CreateDirectory(TuneStateStore.Root);
            File.WriteAllText(DefinitionPath, Definition(exe), Encoding.Unicode);
            rc = Run("/Create", "/F", "/TN", Name, "/XML", DefinitionPath);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            log($"tune: the task definition could not be written to {DefinitionPath}: {e.Message}");
            rc = -1;
        }
        Forget(rc == 0 ? null : $"schtasks could not register the logon revert task (exit {rc})");
        log($"tune: logon revert task {(rc == 0 ? "registered" : $"NOT registered (schtasks exit {rc})")}: {exe} {Verb}");
        return rc == 0;
    }

    public static bool Remove(Action<string> log)
    {
        if (!IsRegistered())
            return true;
        var rc = Run("/Delete", "/F", "/TN", Name);
        Forget(rc == 0 ? null : $"schtasks could not remove the logon revert task (exit {rc})");
        log($"tune: logon revert task {(rc == 0 ? "removed" : $"NOT removed (schtasks exit {rc})")}");
        return rc == 0;
    }

    /// <summary>Every start: with Tune enabled the task is (re)registered so it always
    /// names this exe and this definition, and one that cannot be trusted any more (the exe
    /// moved to a writable folder, an older install's path) is removed rather than left.
    /// With Tune disabled a leftover task is removed the same way.</summary>
    public static void Reconcile(bool enabled, Action<string> log)
    {
        if (!enabled)
        {
            Remove(log);
            return;
        }
        if (!Register(log) && IsRegistered())
            Remove(log);
    }

    private static void Forget(string? problem)
    {
        lock (Gate)
        {
            _registered = null;
            _problem = problem;
        }
    }

    // Any user's logon, SYSTEM at highest level so no prompt stands between a logon and
    // the revert, on battery or not, one instance, two minutes at most.
    private static string Definition(string exe) => $"""
        <?xml version="1.0" encoding="UTF-16"?>
        <Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
          <RegistrationInfo>
            <Description>Puts the GPU clock offsets back if Strata Tune left a candidate applied across a crash (plan section 16).</Description>
          </RegistrationInfo>
          <Triggers>
            <LogonTrigger>
              <Enabled>true</Enabled>
            </LogonTrigger>
          </Triggers>
          <Principals>
            <Principal id="Author">
              <UserId>S-1-5-18</UserId>
              <RunLevel>HighestAvailable</RunLevel>
            </Principal>
          </Principals>
          <Settings>
            <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
            <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
            <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
            <AllowHardTerminate>true</AllowHardTerminate>
            <StartWhenAvailable>true</StartWhenAvailable>
            <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
            <AllowStartOnDemand>true</AllowStartOnDemand>
            <Enabled>true</Enabled>
            <Hidden>false</Hidden>
            <RunOnlyIfIdle>false</RunOnlyIfIdle>
            <WakeToRun>false</WakeToRun>
            <ExecutionTimeLimit>PT2M</ExecutionTimeLimit>
            <Priority>7</Priority>
          </Settings>
          <Actions Context="Author">
            <Exec>
              <Command>{SecurityElement.Escape(exe)}</Command>
              <Arguments>{Verb}</Arguments>
            </Exec>
          </Actions>
        </Task>
        """;

    private static int Run(params string[] args)
    {
        var info = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "schtasks.exe"))
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var a in args)
            info.ArgumentList.Add(a);
        try
        {
            using var process = Process.Start(info);
            if (process is null)
                return -1;
            // Both pipes are drained so schtasks can never block on a full one.
            _ = process.StandardOutput.ReadToEndAsync();
            _ = process.StandardError.ReadToEndAsync();
            if (!process.WaitForExit(Timeout))
            {
                process.Kill();
                return -1;
            }
            return process.ExitCode;
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            return -1;
        }
    }
}
