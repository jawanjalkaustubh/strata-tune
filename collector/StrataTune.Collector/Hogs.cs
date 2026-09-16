using System.ComponentModel;
using System.Diagnostics;
using StrataTune.Shared;

namespace StrataTune.Collector;

/// <summary>The "background hogs" audit input (plan section 8): every process's CPU time and
/// working set at the start and end of an idle window. The collector's own tree (the worker
/// is its child) and the UI's tree are left out, because they are the ones measuring; so
/// are the kernel-backed pseudo-processes, whose working set is the OS's, not a program's.</summary>
internal static class Hogs
{
    private readonly record struct Reading(string Name, TimeSpan Cpu, long WorkingSet, DateTime StartTime);

    private const int SystemPid = 4;
    // Memory Compression holds gigabytes by design, Registry and Secure System are the kernel's,
    // and none of them is something the user could close (Settings > Apps > Startup would be a lie).
    private static readonly HashSet<string> KernelBacked = new(StringComparer.OrdinalIgnoreCase)
    {
        "System", "Idle", "Memory Compression", "Registry", "Secure System",
    };

    public static async Task<HogsResult> SampleAsync(int seconds, int? excludePid, CancellationToken cancel)
    {
        var excluded = ProcessTree.Descendants([Environment.ProcessId, excludePid ?? 0]);
        var start = Sample(excluded);
        var startedAt = Stopwatch.GetTimestamp();
        await Task.Delay(TimeSpan.FromSeconds(seconds), cancel);
        var elapsed = Stopwatch.GetElapsedTime(startedAt).TotalSeconds;
        var end = Sample(excluded);

        var cpus = Environment.ProcessorCount;
        var processes = new List<ProcessSample>();
        foreach (var (pid, after) in end)
        {
            // A pid handed to a new process inside the window has a different start time.
            if (!start.TryGetValue(pid, out var before) || before.StartTime != after.StartTime)
                continue;
            var cpuPercent = (after.Cpu - before.Cpu).TotalSeconds / (elapsed * cpus) * 100;
            processes.Add(new ProcessSample(pid, after.Name, Math.Round(cpuPercent, 2), Math.Round(after.WorkingSet / (1024.0 * 1024), 1)));
        }

        return new HogsResult(seconds, cpus,
            processes.OrderByDescending(p => p.CpuPercent).ThenByDescending(p => p.WorkingSetMiB).ToList());
    }

    private static Dictionary<int, Reading> Sample(HashSet<int> excluded)
    {
        var readings = new Dictionary<int, Reading>();
        foreach (var process in Process.GetProcesses())
            using (process)
            {
                if (process.Id == 0 || process.Id == SystemPid || excluded.Contains(process.Id))
                    continue;
                try
                {
                    if (KernelBacked.Contains(process.ProcessName))
                        continue;
                    readings[process.Id] = new Reading(process.ProcessName, process.TotalProcessorTime, process.WorkingSet64, process.StartTime);
                }
                catch (Exception e) when (e is Win32Exception or InvalidOperationException)
                {
                    // Protected processes refuse the handle and a process can exit between
                    // the listing and the read; neither is a hog we could name anyway.
                }
            }
        return readings;
    }
}
