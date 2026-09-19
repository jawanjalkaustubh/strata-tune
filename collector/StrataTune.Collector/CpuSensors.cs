using System.Text.RegularExpressions;
using LibreHardwareMonitor.Hardware;
using StrataTune.Shared;
using SensorType = LibreHardwareMonitor.Hardware.SensorType;

namespace StrataTune.Collector;

/// <summary>The four CPU readings a load run records, picked out of the LibreHardwareMonitor
/// tree by sensor name once per rebuild. Names differ by vendor ("Package" on AMD, "CPU
/// Package" on Intel; "Core (Tctl/Tdie)" against "CPU Package" temperature), so each field
/// has a preference list and a sensor the box lacks reads null, never 0.</summary>
internal sealed partial class CpuSensors
{
    private readonly ISensor? _package;
    private readonly ISensor? _tctl;
    private readonly ISensor? _averageEffective;
    private readonly ISensor[] _coreEffective;
    private readonly ISensor[] _cores;

    public CpuSensors(IComputer computer)
    {
        var sensors = computer.Hardware.Where(h => h.HardwareType == HardwareType.Cpu).SelectMany(h => h.Sensors).ToArray();
        _package = sensors.FirstOrDefault(s => s.SensorType == SensorType.Power && s.Name.Contains("Package", StringComparison.OrdinalIgnoreCase));
        _tctl = Prefer(sensors, SensorType.Temperature, "Tctl", "CPU Package", "Core Max", "Core Average");
        _averageEffective = sensors.FirstOrDefault(s => s.SensorType == SensorType.Clock && s.Name.Contains("Average Effective", StringComparison.OrdinalIgnoreCase));
        _coreEffective = sensors.Where(s => s.SensorType == SensorType.Clock && CoreEffective().IsMatch(s.Name)).ToArray();
        _cores = sensors.Where(s => s.SensorType == SensorType.Clock && Core().IsMatch(s.Name)).ToArray();
    }

    /// <summary>One sample from the values of the last update; the effective clock falls
    /// back to the mean of the per-core effective clocks, then (Intel, which has no effective
    /// counter in the library) to the mean of the per-core clocks.</summary>
    public CpuSample Read(long qpc) => new(
        qpc,
        Value(_package),
        Value(_tctl),
        Value(_averageEffective) ?? Mean(_coreEffective) ?? Mean(_cores),
        Max(_cores));

    private static ISensor? Prefer(ISensor[] sensors, SensorType type, params string[] names) =>
        names.Select(name => sensors.FirstOrDefault(s => s.SensorType == type && s.Name.Contains(name, StringComparison.OrdinalIgnoreCase)))
            .FirstOrDefault(s => s is not null);

    private static float? Value(ISensor? sensor) =>
        sensor?.Value is { } v && float.IsFinite(v) ? v : null;

    private static float? Mean(ISensor[] sensors) => Finite(sensors) is { Length: > 0 } v ? v.Average() : null;

    private static float? Max(ISensor[] sensors) => Finite(sensors) is { Length: > 0 } v ? v.Max() : null;

    private static float[] Finite(ISensor[] sensors) => sensors.Select(Value).OfType<float>().ToArray();

    // "Core #1 (Effective)" on AMD; nothing on Intel.
    [GeneratedRegex(@"^(CPU )?Core #\d+ \(Effective\)$")]
    private static partial Regex CoreEffective();

    // "Core #1" on AMD, "CPU Core #1" on Intel; never "Bus Speed" or the averages.
    [GeneratedRegex(@"^(CPU )?Core #\d+$")]
    private static partial Regex Core();
}
