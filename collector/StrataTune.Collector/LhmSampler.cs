using System.Diagnostics;
using LibreHardwareMonitor.Hardware;
using StrataTune.Shared;

namespace StrataTune.Collector;

/// <summary>LibreHardwareMonitor at 2 Hz — the slowest the package-power delta allows and
/// the fastest the shared super-IO mutex should be polled (docs/dependencies.md). The
/// constructor opens only the driver and SMBIOS; the hardware groups arrive through
/// <see cref="OpenGroups"/> in stages on the caller's thread while the loop already runs,
/// so the first tick does not wait for the slowest group (phase1-polish item 8). The tree
/// stays open for the life of the service; sensors also appear after a node's first update,
/// so a changed sensor count re-keys the row.</summary>
internal sealed class LhmSampler : IDisposable
{
    public static readonly TimeSpan Period = Lhm.MinimumGap;

    private readonly Computer _computer;
    private readonly RingBuffer _buffer;
    // A sample never overlaps Close(); the group constructors run outside the lock, which is
    // what makes the staging worth having, and the library hands out its hardware list as a
    // snapshot, so a group joining mid-update is simply visited from the next tick.
    private readonly Lock _gate = new();
    // Held for each group's enable and by Dispose, so a quick close during warming never
    // runs Close() under a group constructor; a stage is a few seconds at most and the
    // shutdown deadline bounds the wait.
    private readonly Lock _openGate = new();
    private long _samples;
    private LhmSensor[] _sensors = [];
    private string[] _ids = [];
    private volatile SensorMeta[] _metas = [];
    private CpuSensors _cpu;
    private volatile CpuSample? _latestCpu;

    public LhmSampler(RingBuffer buffer)
    {
        _buffer = buffer;
        _computer = Lhm.OpenEmpty();
        _cpu = new CpuSensors(_computer);
    }

    public IReadOnlyList<SensorMeta> Metas => _metas;

    /// <summary>The CPU readings of the last update, for a load run's cpuSamples; null before the CPU group is in.</summary>
    public CpuSample? LatestCpu => _latestCpu;

    public Task RunAsync(Log log, CancellationToken stopping) =>
        SampleLoop.RunAsync("lhm", Period, Sample, log, stopping);

    /// <summary>CPU, board and GPU first (the panels the user looks at), memory next, storage
    /// last (SMART over every drive is the slow one). Each group logs its own t+X line; a
    /// group that throws is left out and the others still open. A group's sensors activate on
    /// its first update, so the next tick's count check is what re-keys the row.</summary>
    public void OpenGroups(bool pawnIoUsable, Log log, Func<string> stamp, CancellationToken stopping)
    {
        (string Name, bool Wanted, Action Enable)[] stages =
        [
            ("cpu", pawnIoUsable, () => _computer.IsCpuEnabled = true),
            ("motherboard", pawnIoUsable, () => _computer.IsMotherboardEnabled = true),
            ("gpu", true, () => _computer.IsGpuEnabled = true),
            ("memory", true, () => _computer.IsMemoryEnabled = true),
            ("storage", true, () => _computer.IsStorageEnabled = true),
        ];
        foreach (var (name, wanted, enable) in stages)
        {
            if (!wanted)
                continue;
            lock (_openGate)
            {
                if (stopping.IsCancellationRequested)
                    return;
                try
                {
                    enable();
                    log.Write($"{stamp()} lhm {name} open");
                }
                catch (Exception e)
                {
                    log.Write($"{stamp()} lhm {name} failed to open, left out: {e.GetType().Name}: {e.Message}");
                }
            }
        }
    }

    /// <summary>The sample count after which the sensors of the groups enabled so far are in
    /// the list: a sample already under way when the last group joined may have counted
    /// before it, the one after it cannot have.</summary>
    public long SettledAt => Interlocked.Read(ref _samples) + 2;

    /// <summary>Waits for the sample count to reach <paramref name="target"/>. Bounded,
    /// because a sampler whose every update throws completes no sample and must not hold
    /// warming open.</summary>
    public void WaitForSamples(long target, CancellationToken stopping)
    {
        var deadline = DateTime.UtcNow + Period * 6;
        while (Interlocked.Read(ref _samples) < target && DateTime.UtcNow < deadline && !stopping.IsCancellationRequested)
            Thread.Sleep(50);
    }

    private void Sample()
    {
        lock (_gate)
        {
            Lhm.Update(_computer);
            var qpc = Stopwatch.GetTimestamp();
            if (SensorIds.Count(_computer) != _sensors.Length)
                Rebuild();

            var values = new float[_sensors.Length];
            for (var i = 0; i < values.Length; i++)
                values[i] = _sensors[i].Sensor.Value ?? float.NaN;
            _buffer.Append(qpc, _ids, values);
            _latestCpu = _cpu.Read(qpc);
            Interlocked.Increment(ref _samples);
        }
    }

    private void Rebuild()
    {
        _sensors = SensorIds.Enumerate(_computer).ToArray();
        _ids = _sensors.Select(s => s.Meta.Id).ToArray();
        _metas = _sensors.Select(s => s.Meta).ToArray();
        _cpu = new CpuSensors(_computer);
    }

    public void Dispose()
    {
        lock (_openGate)
        lock (_gate)
            _computer.Close();
    }
}
