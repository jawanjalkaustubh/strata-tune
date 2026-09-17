using System.Diagnostics;
using System.Globalization;

namespace StrataTune.Collector;

/// <summary>The two facts plan section 16's "clean boot after a clean shutdown" needs and
/// the collector's own exit cannot supply: which boot this is, and whether Windows itself
/// recorded a dirty shutdown since a value went on the card. The collector exiting cleanly
/// says nothing about the hours the machine then ran with a kept result applied; the
/// System log does (Kernel-Power 41 and EventLog 6008 are written at the boot that follows
/// a hang or a power cut), and the boot time says whether the card has even been through
/// a reboot, which is what takes an NVAPI P0 delta off it.</summary>
internal static class BootRecord
{
    // Two boots less than this apart are the same boot: the clock may step at a sync, and
    // the tick-count fallback drifts by a few milliseconds a day against it.
    private static readonly TimeSpan SameBootTolerance = TimeSpan.FromSeconds(90);
    private static readonly TimeSpan QueryTimeout = TimeSpan.FromSeconds(15);
    private static readonly Lock Gate = new();
    private static DateTimeOffset? _bootedAt;

    /// <summary>When this boot happened, from Win32_OperatingSystem.LastBootUpTime (which
    /// fast startup does not reset: a hibernate-resume is the same boot, and whether the
    /// card kept its deltas across it is read from the card, not assumed). The tick count
    /// is the fallback, and it stops during sleep on this box (measured 2 h short of WMI
    /// after a sleep), so it is not the first choice.</summary>
    public static DateTimeOffset BootedAt
    {
        get
        {
            lock (Gate)
                return _bootedAt ??= FromWmi() ?? DateTimeOffset.UtcNow - TimeSpan.FromMilliseconds(Environment.TickCount64);
        }
    }

    public static string BootedAtIso => BootedAt.ToString("O");

    public static bool SameBoot(string? recordedIso) =>
        recordedIso is not null && DateTimeOffset.TryParse(recordedIso, null, DateTimeStyles.RoundtripKind, out var recorded)
        && (BootedAt - recorded).Duration() < SameBootTolerance;

    private static DateTimeOffset? FromWmi()
    {
        try
        {
            using var searcher = new System.Management.ManagementObjectSearcher(new System.Management.ManagementScope(Wmi.Cimv2), new System.Management.ObjectQuery("SELECT LastBootUpTime FROM Win32_OperatingSystem"));
            using var results = searcher.Get();
            foreach (var row in results)
                using (row)
                    if (row["LastBootUpTime"]?.ToString() is { } text)
                        return new DateTimeOffset(System.Management.ManagementDateTimeConverter.ToDateTime(text).ToUniversalTime());
            return null;
        }
        catch (Exception e) when (e is System.Management.ManagementException or System.Runtime.InteropServices.COMException or InvalidOperationException or FormatException)
        {
            return null;
        }
    }

    /// <summary>True when the System log holds a Kernel-Power 41 or an EventLog 6008 stamped
    /// after <paramref name="sinceIso"/>; false when it holds none; null when the log could
    /// not be asked, which the caller must treat as "not known to be clean".</summary>
    public static bool? UnexpectedShutdownSince(string sinceIso, Action<string> log)
    {
        if (!DateTimeOffset.TryParse(sinceIso, null, DateTimeStyles.RoundtripKind, out var since))
            return null;
        var query = $"*[System[((Provider[@Name='Microsoft-Windows-Kernel-Power'] and EventID=41) or (Provider[@Name='EventLog'] and EventID=6008)) and TimeCreated[@SystemTime>='{since.UtcDateTime:yyyy-MM-dd'T'HH:mm:ss.fff'Z'}']]]";
        var info = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "wevtutil.exe"))
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var a in new[] { "qe", "System", $"/q:{query}", "/c:1", "/f:text", "/rd:true" })
            info.ArgumentList.Add(a);
        try
        {
            using var process = Process.Start(info);
            if (process is null)
                return null;
            var stdout = process.StandardOutput.ReadToEndAsync();
            var stderr = process.StandardError.ReadToEndAsync();
            if (!process.WaitForExit(QueryTimeout))
            {
                process.Kill();
                log("tune: wevtutil did not answer in time; the boot cannot be called clean");
                return null;
            }
            if (process.ExitCode != 0)
            {
                log($"tune: wevtutil exit {process.ExitCode}: {stderr.Result.Trim()}");
                return null;
            }
            var text = stdout.Result.Trim();
            if (text.Length == 0)
                return false;
            log($"tune: the System log records a dirty shutdown after {sinceIso}: {FirstLine(text)}");
            return true;
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            log($"tune: wevtutil could not run: {e.Message}");
            return null;
        }
    }

    private static string FirstLine(string text)
    {
        var lines = text.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        return string.Join(" ", lines.Take(4));
    }
}
