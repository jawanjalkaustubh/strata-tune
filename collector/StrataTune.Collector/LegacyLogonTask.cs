using System.Diagnostics;

namespace StrataTune.Collector;

/// <summary>The Phase 8 build registered a Task Scheduler entry that ran this exe elevated
/// at every logon to revert a rung left on the card. This build has none (plan section 16,
/// 2026-09-16): P0 deltas do not survive a boot, and every collector start reverts a
/// pending rung itself. A task that build left is removed once, at start, and logged, so
/// no elevated task keeps pointing at an exe path that may move or be replaced.</summary>
internal static class LegacyLogonTask
{
    public const string Name = "Strata Tune revert-if-pending";
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(15);

    public static void RemoveIfPresent(Action<string> log)
    {
        if (Run("/Query", "/TN", Name) != 0)
            return;
        var rc = Run("/Delete", "/F", "/TN", Name);
        log(rc == 0
            ? $"tune: the logon task '{Name}' left by an earlier build was removed; this build reverts at every collector start instead"
            : $"tune: the logon task '{Name}' left by an earlier build could not be removed (schtasks exit {rc}); remove it by hand with schtasks /Delete /F /TN \"{Name}\"");
    }

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
