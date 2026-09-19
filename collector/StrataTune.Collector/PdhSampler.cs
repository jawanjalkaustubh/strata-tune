using System.Diagnostics;
using StrataTune.Shared;

namespace StrataTune.Collector;

/// <summary>PhysicalDisk queue depth at 1 Hz through PDH. Instances are named like
/// "2 D: E: C:" — the leading number is the disk index, which is what the id carries so it
/// lines up with the snapshot's physical disks. Counters stay open between samples
/// (docs/dependencies.md); one that disappears re-enumerates the set. A performance-counter
/// registry that is broken (the lodctr /R condition) leaves the set empty and is retried
/// on the next tick, so this optional counter never costs the rest of the stream.</summary>
internal sealed class PdhSampler : IDisposable
{
    public static readonly TimeSpan Period = TimeSpan.FromSeconds(1);

    private const string Category = "PhysicalDisk";
    private const string Counter = "Current Disk Queue Length";
    private const string TotalInstance = "_Total";

    private static readonly TimeSpan RetryGap = TimeSpan.FromMinutes(1);

    private readonly RingBuffer _buffer;
    private readonly Log _log;
    private List<PerformanceCounter> _counters = [];
    private string[] _ids = [];
    private volatile SensorMeta[] _metas = [];
    private DateTimeOffset _lastFailure = DateTimeOffset.MinValue;

    public PdhSampler(RingBuffer buffer, Log log)
    {
        _buffer = buffer;
        _log = log;
        Enumerate();
    }

    public IReadOnlyList<SensorMeta> Metas => _metas;

    public Task RunAsync(Log log, CancellationToken stopping) =>
        SampleLoop.RunAsync("pdh", Period, Sample, log, stopping);

    private void Sample()
    {
        if (_counters.Count == 0)
        {
            if (DateTimeOffset.UtcNow - _lastFailure >= RetryGap)
                Enumerate();
            return;
        }
        var qpc = Stopwatch.GetTimestamp();
        var values = new float[_counters.Count];
        try
        {
            for (var i = 0; i < values.Length; i++)
                values[i] = _counters[i].NextValue();
        }
        catch (InvalidOperationException)
        {
            Enumerate();
            return;
        }
        _buffer.Append(qpc, _ids, values);
    }

    private void Enumerate()
    {
        foreach (var c in _counters)
            c.Dispose();
        _counters = [];
        try
        {
            var instances = new PerformanceCounterCategory(Category).GetInstanceNames()
                .Where(n => n != TotalInstance)
                .OrderBy(n => n, StringComparer.Ordinal)
                .ToList();
            _counters = instances.Select(n => new PerformanceCounter(Category, Counter, n, readOnly: true)).ToList();
            _metas = instances.Select(n =>
            {
                var index = n.Split(' ', 2)[0];
                return new SensorMeta($"/pdh/physicaldisk/{index}/queue", $"/pdh/physicaldisk/{index}", n, "Storage",
                    "Disk queue length", SensorType.Factor, "");
            }).ToArray();
            _ids = _metas.Select(m => m.Id).ToArray();
        }
        catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception or UnauthorizedAccessException)
        {
            _metas = [];
            _ids = [];
            _lastFailure = DateTimeOffset.UtcNow;
            _log.Write($"pdh: {Category} counters unavailable, disk queue depth left out: {e.Message}");
        }
    }

    public void Dispose()
    {
        foreach (var c in _counters)
            c.Dispose();
    }
}
