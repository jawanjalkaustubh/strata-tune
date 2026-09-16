using System.Diagnostics;
using StrataTune.Shared;

namespace StrataTune.Collector;

/// <summary>NVML at 10 Hz. Each GPU's fields get synthetic /nvml/&lt;i&gt;/... ids in the
/// sensor stream (plan section 6) and the whole <see cref="GpuFacts"/> read is kept for the
/// live tick and the GPU endpoint. Power is folded to watts so it lines up with the
/// library's Power sensors; the GpuFacts shape keeps NVML's milliwatts.</summary>
internal sealed class NvmlSampler
{
    public static readonly TimeSpan Period = TimeSpan.FromMilliseconds(100);

    private static readonly (string Path, string Name, SensorType Type, string Unit, Func<GpuFacts, float> Read)[] Fields =
    [
        ("clocks/sm", "SM clock", SensorType.Clock, "MHz", g => g.Clocks.SmMhz),
        ("clocks/mem", "Memory clock", SensorType.Clock, "MHz", g => g.Clocks.MemMhz),
        ("power", "Board power", SensorType.Power, "W", g => g.PowerMw / 1000f),
        ("powerLimit", "Power limit", SensorType.Power, "W", g => g.PowerLimitMw / 1000f),
        ("temperature", "GPU temperature", SensorType.Temperature, "°C", g => g.TemperatureC),
        ("vram/used", "VRAM used", SensorType.SmallData, "MB", g => g.Vram.UsedMiB),
        ("vram/total", "VRAM total", SensorType.SmallData, "MB", g => g.Vram.TotalMiB),
        ("util/gpu", "GPU utilisation", SensorType.Load, "%", g => g.Utilisation.Gpu),
        ("util/mem", "Memory controller utilisation", SensorType.Load, "%", g => g.Utilisation.Memory),
        ("pcie/gen", "PCIe generation", SensorType.Factor, "", g => g.Pcie.CurrentGen),
        ("pcie/width", "PCIe width", SensorType.Factor, "", g => g.Pcie.CurrentWidth),
        ("clocksEventReasons", "Clocks event reasons", SensorType.Factor, "", g => g.ClocksEventReasons.Raw),
    ];

    private readonly Nvml.Session _session;
    private readonly RingBuffer _buffer;
    private readonly string[] _ids;
    private volatile IReadOnlyList<GpuFacts> _latest;

    public NvmlSampler(Nvml.Session session, RingBuffer buffer)
    {
        _session = session;
        _buffer = buffer;
        _latest = session.Read();
        Metas = _latest.SelectMany(g => Fields.Select(f => new SensorMeta(
            $"/nvml/{g.Index}/{f.Path}", $"/nvml/{g.Index}", g.Name, "GpuNvidia", f.Name, f.Type, f.Unit))).ToArray();
        _ids = Metas.Select(m => m.Id).ToArray();
    }

    public IReadOnlyList<SensorMeta> Metas { get; }

    public IReadOnlyList<GpuFacts> Latest => _latest;

    public Task RunAsync(Log log, CancellationToken stopping) =>
        SampleLoop.RunAsync("nvml", Period, Sample, log, stopping);

    private void Sample()
    {
        var qpc = Stopwatch.GetTimestamp();
        var gpus = _session.Read();
        _latest = gpus;
        var values = new float[_ids.Length];
        Array.Fill(values, float.NaN);
        var i = 0;
        foreach (var g in gpus)
            foreach (var f in Fields)
            {
                if (i < values.Length)
                    values[i] = f.Read(g);
                i++;
            }
        _buffer.Append(qpc, _ids, values);
    }
}
