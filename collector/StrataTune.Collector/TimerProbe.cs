using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Xml.Linq;
using StrataTune.Shared;

namespace StrataTune.Collector;

/// <summary>GET /timers (plan sections 8 and 17): the Windows timer resolution and the clock
/// behind QueryPerformanceCounter, and on request the processes holding the timer. Reads
/// only. The resolution comes from NtQueryTimerResolution, the one call that reports what
/// the kernel is actually using rather than what a process asked for; who asked is not a
/// public API, so the trace is powercfg's energy report (elevated, a few seconds), which
/// lists every outstanding request with its pid and path.</summary>
internal static class TimerProbe
{
    private const double HundredNsPerMs = 10_000;
    private const int MinTraceSeconds = 1, MaxTraceSeconds = 30;
    // powercfg observes for the duration and then analyses; the analysis has taken 20 s on a slow box.
    private static readonly TimeSpan TraceOverhead = TimeSpan.FromSeconds(60);

    [DllImport("ntdll.dll")]
    private static extern int NtQueryTimerResolution(out uint minimum, out uint maximum, out uint current);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint QueryDosDeviceW(string deviceName, StringBuilder targetPath, int max);

    public static async Task<Timers> ReadAsync(int? traceSeconds, int? excludePid, Log log, CancellationToken cancel)
    {
        var (current, finest, coarsest) = Resolution();
        var frequency = Stopwatch.Frequency;
        var (source, note) = QpcSource(frequency);
        IReadOnlyList<TimerRequester>? requesters = null;
        string? requestersNote = null;
        if (traceSeconds is { } seconds)
        {
            // Nothing raised the timer: no process to name and no trace to spend seconds on.
            if (current is null || current >= coarsest)
            {
                requesters = [];
                requestersNote = "the timer is at the platform default, so no process holds it raised";
            }
            else
            {
                (requesters, requestersNote) = await TraceAsync(Math.Clamp(seconds, MinTraceSeconds, MaxTraceSeconds), excludePid, log, cancel);
            }
        }
        return new Timers(current, finest, coarsest, frequency, source, note, requesters, requestersNote);
    }

    /// <summary>Milliseconds. NT's "minimum resolution" is the coarsest period (the largest
    /// number), its "maximum" the finest; a failed call answers nulls, never a guess.</summary>
    private static (double? Current, double? Finest, double? Coarsest) Resolution()
    {
        if (NtQueryTimerResolution(out var minimum, out var maximum, out var current) != 0)
            return (null, null, null);
        return (current / HundredNsPerMs, maximum / HundredNsPerMs, minimum / HundredNsPerMs);
    }

    /// <summary>Windows fixes the counter frequency at boot from the clock it chose, so the
    /// frequency names the clock: 10 MHz is the invariant TSC (the kernel scales it to that
    /// figure), 14.318 MHz is the HPET, 3.5795 MHz the ACPI power-management timer. Anything
    /// else is a hypervisor's reference counter or a clock this table does not know.</summary>
    internal static (string Source, string Note) QpcSource(long frequency) => frequency switch
    {
        10_000_000 => ("TSC", "invariant TSC, scaled to 10 MHz by the kernel; the fastest source and the Windows default"),
        14_318_180 => ("HPET", "the HPET rate: useplatformclock is set in the boot configuration, which costs a few hundred ns per timestamp"),
        3_579_545 => ("ACPI PM timer", "the ACPI power-management timer: the slowest source, chosen when the TSC is not usable"),
        _ => ("unknown", $"{frequency} Hz matches none of the clocks Windows picks on bare metal; a hypervisor's reference counter reads like this"),
    };

    // powercfg /energy is the documented way to see who holds the timer: elevated, it watches
    // for the duration and lists each outstanding request with its period, pid and image path.
    // It exits non-zero whenever its report contains errors, so only a missing file is a failure.
    private static async Task<(IReadOnlyList<TimerRequester> Requesters, string? Note)> TraceAsync(int seconds, int? excludePid, Log log, CancellationToken cancel)
    {
        var output = Path.Combine(Path.GetTempPath(), $"strata-tune-energy-{Guid.NewGuid():N}.xml");
        try
        {
            using var process = Process.Start(new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "powercfg.exe"))
            {
                ArgumentList = { "/energy", "/duration", seconds.ToString(), "/xml", "/output", output },
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            });
            if (process is null)
                return ([], "powercfg did not start");
            var drain = Task.WhenAll(process.StandardOutput.ReadToEndAsync(cancel), process.StandardError.ReadToEndAsync(cancel));
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancel);
            deadline.CancelAfter(TimeSpan.FromSeconds(seconds) + TraceOverhead);
            try
            {
                await process.WaitForExitAsync(deadline.Token);
            }
            catch (OperationCanceledException)
            {
                try { process.Kill(); } catch (InvalidOperationException) { /* already gone */ }
                return ([], cancel.IsCancellationRequested ? "the trace was cancelled" : "powercfg did not finish in time");
            }
            await drain;
            if (!File.Exists(output))
                return ([], $"powercfg wrote no report (exit {process.ExitCode})");
            var own = ProcessTree.Descendants([Environment.ProcessId, excludePid ?? 0]);
            var requesters = ParseRequesters(File.ReadAllText(output), own);
            return (requesters, requesters.Count == 0 ? $"powercfg's {seconds} s trace listed no outstanding timer request" : null);
        }
        catch (Exception e) when (e is IOException or System.ComponentModel.Win32Exception or InvalidOperationException or System.Xml.XmlException)
        {
            log.Write($"timers trace: {e.Message}");
            return ([], $"the trace failed: {e.Message}");
        }
        finally
        {
            try { File.Delete(output); } catch (IOException) { /* the temp folder keeps it */ }
        }
    }

    /// <summary>Each entry of the energy report with a "Requesting Process ID" detail, whatever
    /// element carries it: the report's schema names its containers LogEntry / Details /
    /// Detail, but only the Name / Value pairs are relied on. Paths are NT device paths
    /// (\Device\HarddiskVolume3\...), turned back into drive letters where a letter maps.</summary>
    internal static IReadOnlyList<TimerRequester> ParseRequesters(string xml, HashSet<int> own)
    {
        var doc = XDocument.Parse(xml);
        var requesters = new List<TimerRequester>();
        var seen = new HashSet<int>();
        var byContainer = doc.Descendants()
            .Where(e => e.Name.LocalName == "Detail" && e.Parent is not null)
            .GroupBy(e => e.Parent!);
        foreach (var group in byContainer)
        {
            var details = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var detail in group)
            {
                var key = detail.Elements().FirstOrDefault(c => c.Name.LocalName == "Name")?.Value.Trim();
                var value = detail.Elements().FirstOrDefault(c => c.Name.LocalName == "Value")?.Value.Trim();
                if (key is not null && value is not null)
                    details[key] = value;
            }
            if (!details.TryGetValue("Requesting Process ID", out var pidText) || !int.TryParse(pidText, out var pid) || !seen.Add(pid))
                continue;
            details.TryGetValue("Requesting Process Path", out var rawPath);
            var path = rawPath is null ? null : DrivePath(rawPath);
            double? period = details.TryGetValue("Requested Period", out var periodText) && double.TryParse(periodText, out var hundredNs) ? hundredNs / HundredNsPerMs : null;
            var name = path is null ? ProcessName(pid) : Path.GetFileName(path);
            requesters.Add(new TimerRequester(pid, name, path, period, own.Contains(pid)));
        }
        return requesters.OrderBy(r => r.PeriodMs).ThenBy(r => r.Pid).ToList();
    }

    private static string ProcessName(int pid)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            return process.ProcessName + ".exe";
        }
        catch (Exception e) when (e is ArgumentException or InvalidOperationException)
        {
            return $"pid {pid}";
        }
    }

    // "\Device\HarddiskVolume3\Windows\explorer.exe" → "C:\Windows\explorer.exe", when a
    // drive letter maps to that volume; a path on a volume without a letter stays as it is.
    private static string DrivePath(string ntPath)
    {
        if (!ntPath.StartsWith(@"\Device\", StringComparison.OrdinalIgnoreCase))
            return ntPath;
        var target = new StringBuilder(260);
        for (var letter = 'A'; letter <= 'Z'; letter++)
        {
            var drive = $"{letter}:";
            if (QueryDosDeviceW(drive, target, target.Capacity) == 0)
                continue;
            var device = target.ToString();
            if (device.Length > 0 && ntPath.StartsWith(device + @"\", StringComparison.OrdinalIgnoreCase))
                return drive + ntPath[device.Length..];
            target.Clear();
        }
        return ntPath;
    }
}
