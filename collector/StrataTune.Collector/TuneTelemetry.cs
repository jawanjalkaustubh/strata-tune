using StrataTune.Shared;

namespace StrataTune.Collector;

/// <summary>The sensor ids a scored run's telemetry reads beside the NVML facts: the
/// library's hotspot and memory-junction temperatures and the fan duties of the card under
/// test, found by name under its hardware node once per run. A card without them (a
/// Founders Edition reports no fan duty to the library; a laptop's dGPU no memory junction)
/// leaves the field null and the summary leaves the row out.</summary>
internal sealed record TelemetryIds(string? Hotspot, string? MemoryJunction, IReadOnlyList<string> Fans)
{
    public static readonly TelemetryIds None = new(null, null, []);

    /// <summary>The GPU node whose name is the NVML card's, else the first NVIDIA node, else
    /// the first GPU node: the same choice the Monitor page makes (src/components/monitor/gpuLayout.ts).</summary>
    public static TelemetryIds Find(IReadOnlyList<SensorMeta> metas, string? gpuName)
    {
        var gpu = metas.Where(m => m.HardwareType.StartsWith("Gpu", StringComparison.OrdinalIgnoreCase)).ToList();
        var node = gpu.FirstOrDefault(m => string.Equals(m.HardwareName, gpuName, StringComparison.OrdinalIgnoreCase))?.Hardware
            ?? gpu.FirstOrDefault(m => m.HardwareType.Equals("GpuNvidia", StringComparison.OrdinalIgnoreCase))?.Hardware
            ?? gpu.FirstOrDefault()?.Hardware;
        if (node is null)
            return None;
        var mine = gpu.Where(m => m.Hardware == node).ToList();
        string? Temperature(string word) => mine.FirstOrDefault(m => m.SensorType == SensorType.Temperature && m.Name.Contains(word, StringComparison.OrdinalIgnoreCase))?.Id;
        return new(
            Temperature("Hot Spot") ?? Temperature("Hotspot"),
            Temperature("Memory Junction"),
            mine.Where(m => m.SensorType == SensorType.Control && m.Name.StartsWith("GPU Fan", StringComparison.OrdinalIgnoreCase)).Select(m => m.Id).ToList());
    }
}

/// <summary>Running average and peak of one figure over a scored run.</summary>
internal sealed class Stat
{
    private double _sum, _max;
    private int _n;

    public void Add(double value)
    {
        _sum += value;
        _max = _n == 0 ? value : Math.Max(_max, value);
        _n++;
    }

    /// <summary>Null when nothing was ever added: the sensor is absent on this box.</summary>
    public TelemetryStat? Result => _n == 0 ? null : new(Math.Round(_sum / _n, 1), Math.Round(_max, 1));
}

/// <summary>The per-component summary of a scored run (plan section 16, the .html
/// comparison sheet): fed one 2 Hz sample at a time by the flight recorder between Begin
/// and End, so the numbers cover exactly the run's own minutes. The limit-reason share is
/// per decoded NVML bit name; an unknown bit keeps its hex spelling.</summary>
internal sealed class TelemetryWindow(TelemetryIds ids)
{
    private readonly Stat _coreMhz = new(), _memMhz = new(), _coreC = new(), _hotspotC = new(), _junctionC = new(), _boardW = new(), _fan = new();
    private readonly Stat _effectiveMhz = new(), _packageW = new(), _tctlC = new();
    private readonly Dictionary<string, int> _limits = [];
    private readonly DateTimeOffset _started = DateTimeOffset.UtcNow;
    private int _samples, _gpuSamples, _cpuSamples;
    private double _capW, _maxCoreMhz;

    public void Add(GpuFacts? gpu, CpuSample? cpu, SensorRow row)
    {
        _samples++;
        if (gpu is not null)
        {
            _gpuSamples++;
            _coreMhz.Add(gpu.Clocks.SmMhz);
            _memMhz.Add(gpu.Clocks.MemMhz);
            _coreC.Add(gpu.TemperatureC);
            _boardW.Add(gpu.PowerMw / 1000.0);
            _capW = Math.Max(_capW, gpu.PowerLimitMw / 1000.0);
            foreach (var name in gpu.ClocksEventReasons.Names)
                _limits[name] = _limits.GetValueOrDefault(name) + 1;
        }
        if (ids.Hotspot is { } hot && row.Values.TryGetValue(hot, out var h))
            _hotspotC.Add(h);
        if (ids.MemoryJunction is { } junction && row.Values.TryGetValue(junction, out var j))
            _junctionC.Add(j);
        // Several fans: the sample's figure is the fastest of them.
        float? fan = null;
        foreach (var id in ids.Fans)
            if (row.Values.TryGetValue(id, out var duty))
                fan = fan is { } f ? Math.Max(f, duty) : duty;
        if (fan is { } duty2)
            _fan.Add(duty2);
        if (cpu is not null)
        {
            _cpuSamples++;
            if (cpu.AvgEffectiveMhz is { } avg)
                _effectiveMhz.Add(avg);
            if (cpu.MaxCoreMhz is { } max)
                _maxCoreMhz = Math.Max(_maxCoreMhz, max);
            if (cpu.PackageW is { } w)
                _packageW.Add(w);
            if (cpu.TctlC is { } t)
                _tctlC.Add(t);
        }
    }

    public TelemetrySummary Result()
    {
        var seconds = Math.Round((DateTimeOffset.UtcNow - _started).TotalSeconds, 1);
        GpuTelemetry? gpu = null;
        if (_gpuSamples > 0)
        {
            var limits = _limits.ToDictionary(kv => kv.Key, kv => Math.Round(kv.Value / (double)_gpuSamples, 3));
            gpu = new(_coreMhz.Result!, _memMhz.Result!, _coreC.Result!, _hotspotC.Result, _junctionC.Result, _boardW.Result!, _capW, limits, _fan.Result);
        }
        CpuTelemetry? cpu = null;
        if (_cpuSamples > 0)
        {
            // The effective clock's peak is the fastest single core of any sample, its average the per-sample all-core average.
            var effective = _effectiveMhz.Result is { } e ? new TelemetryStat(e.Avg, Math.Round(Math.Max(e.Max, _maxCoreMhz), 1)) : null;
            cpu = new(effective, _packageW.Result, _tctlC.Result);
        }
        return new(_samples, seconds, gpu, cpu);
    }
}
