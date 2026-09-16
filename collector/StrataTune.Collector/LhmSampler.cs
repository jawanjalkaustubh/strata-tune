using System.Diagnostics;
using LibreHardwareMonitor.Hardware;
using StrataTune.Shared;

namespace StrataTune.Collector;

/// <summary>LibreHardwareMonitor at 2 Hz — the slowest the package-power delta allows and
/// the fastest the shared super-IO mutex should be polled (docs/dependencies.md). The
/// tree stays open for the life of the service; the library can add sensors after the
/// first update (GPU nodes fill in lazily), so a changed sensor count re-keys the row.</summary>
internal sealed class LhmSampler : IDisposable
{
    public static readonly TimeSpan Period = Lhm.MinimumGap;

    private readonly Computer _computer;
    private readonly RingBuffer _buffer;
    private LhmSensor[] _sensors = [];
    private string[] _ids = [];
    private volatile SensorMeta[] _metas = [];

    public LhmSampler(bool pawnIoUsable, RingBuffer buffer)
    {
        _buffer = buffer;
        _computer = Lhm.Open(pawnIoUsable);
        Lhm.Update(_computer);
        Rebuild();
    }

    public IReadOnlyList<SensorMeta> Metas => _metas;

    public Task RunAsync(Log log, CancellationToken stopping) =>
        SampleLoop.RunAsync("lhm", Period, Sample, log, stopping);

    private void Sample()
    {
        Lhm.Update(_computer);
        var qpc = Stopwatch.GetTimestamp();
        if (SensorIds.Count(_computer) != _sensors.Length)
            Rebuild();

        var values = new float[_sensors.Length];
        for (var i = 0; i < values.Length; i++)
            values[i] = _sensors[i].Sensor.Value ?? float.NaN;
        _buffer.Append(qpc, _ids, values);
    }

    private void Rebuild()
    {
        _sensors = SensorIds.Enumerate(_computer).ToArray();
        _ids = _sensors.Select(s => s.Meta.Id).ToArray();
        _metas = _sensors.Select(s => s.Meta).ToArray();
    }

    public void Dispose() => _computer.Close();
}
