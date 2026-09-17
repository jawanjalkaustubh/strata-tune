using Microsoft.Win32;

namespace StrataTune.Collector;

/// <summary>Whether Windows will actually end a hung GPU (dependencies.md: never run with
/// the timeout disabled). The ladder's stage 3 is a TDR: with TdrLevel 0, or a TdrDelay long
/// enough that the worker's deadline kill cannot tear the device down, a stage-3 failure is
/// a fence the worker waits on forever, a heartbeat that keeps ticking, and a run that only
/// a hard reset ends, with the candidate still on the card. Overclockers' boxes often carry
/// exactly that registry edit, so a hunt refuses to start on one.</summary>
internal static class TdrPolicy
{
    private const string Key = @"SYSTEM\CurrentControlSet\Control\GraphicsDrivers";
    // Windows defaults: recovery on (3), 2 s detection, 5 s DDI; more than this and the
    // worker's post-kill wait and the 15 s device-loss gap no longer bound anything.
    private const int DefaultLevel = 3, DefaultDelaySeconds = 2, DefaultDdiDelaySeconds = 5, MaxDelaySeconds = 10;

    /// <summary>Why a hunt must not start, or null when the timeout is on and short enough.</summary>
    public static string? Problem()
    {
        try
        {
            using var key = Registry.LocalMachine.OpenSubKey(Key);
            var level = key?.GetValue("TdrLevel") as int? ?? DefaultLevel;
            var delay = key?.GetValue("TdrDelay") as int? ?? DefaultDelaySeconds;
            var ddiDelay = key?.GetValue("TdrDdiDelay") as int? ?? DefaultDdiDelaySeconds;
            if (level == 0)
                return "GPU timeout detection is off (TdrLevel 0 under HKLM\\...\\GraphicsDrivers): a hung candidate would never become a driver reset, so the ladder cannot run safely; remove the key and reboot";
            if (delay > MaxDelaySeconds || ddiDelay > MaxDelaySeconds)
                return $"the GPU timeout is set to {Math.Max(delay, ddiDelay)} s (TdrDelay {delay}, TdrDdiDelay {ddiDelay} under HKLM\\...\\GraphicsDrivers); a hunt needs the Windows default (2 s) or at most {MaxDelaySeconds} s";
            return null;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or System.Security.SecurityException)
        {
            return $"the GPU timeout policy could not be read: {e.Message}";
        }
    }
}
