using System.Diagnostics;

namespace StrataTune.Collector;

internal sealed record DiskQueueReading(string Instance, float First, float Second);

internal sealed record PdhReadings(
    IReadOnlyList<DiskQueueReading> DiskQueue,
    string ProcessInstance,
    float OwnCpuPercent);

/// <summary>Windows performance counters. Readable without elevation. Rate counters return 0
/// on the first NextValue(), so everything is sampled twice with the same one-second gap.</summary>
internal static class Pdh
{
    private const string DiskCategory = "PhysicalDisk";
    private const string DiskCounter = "Current Disk Queue Length";
    private const string TotalInstance = "_Total";
    // "Process V2" names instances <exe>:<pid>; the classic "Process" category has the #1/#2
    // ambiguity and renumbers when a process exits.
    private const string ProcessCategory = "Process V2";
    private const string ProcessCounter = "% Processor Time";

    private static readonly TimeSpan SampleGap = TimeSpan.FromSeconds(1);

    public static PdhReadings Read()
    {
        var disks = new PerformanceCounterCategory(DiskCategory).GetInstanceNames()
            // _Total is a pseudo-instance; plan section 6 keys the disk stream on real disks.
            .Where(n => n != TotalInstance)
            .OrderBy(n => n, StringComparer.Ordinal)
            .Select(n => new PerformanceCounter(DiskCategory, DiskCounter, n, readOnly: true))
            .ToList();
        var self = new PerformanceCounter(ProcessCategory, ProcessCounter, OwnInstance(), readOnly: true);
        try
        {
            var first = disks.Select(c => c.NextValue()).ToList();
            self.NextValue();
            Thread.Sleep(SampleGap);
            var queue = disks.Select((c, i) => new DiskQueueReading(c.InstanceName, first[i], c.NextValue())).ToList();
            // The counter sums every logical CPU (0..100 × count); the UI wants 0..100.
            var cpu = self.NextValue() / Environment.ProcessorCount;
            return new PdhReadings(queue, self.InstanceName, cpu);
        }
        finally
        {
            self.Dispose();
            foreach (var c in disks)
                c.Dispose();
        }
    }

    private static string OwnInstance()
    {
        var suffix = ":" + Environment.ProcessId;
        return new PerformanceCounterCategory(ProcessCategory).GetInstanceNames()
            .FirstOrDefault(n => n.EndsWith(suffix, StringComparison.Ordinal))
            ?? throw new InvalidOperationException($"no '{ProcessCategory}' instance ends with '{suffix}'");
    }
}
