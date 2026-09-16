namespace StrataTune.Shared;

/// <summary>LibreHardwareMonitor's sensor kinds, spelled the same so the UI can switch on them.</summary>
public enum SensorType
{
    Voltage, Current, Power, Clock, Temperature, Load, Frequency, Fan, Flow, Control, Level,
    Factor, Data, SmallData, Throughput, TimeSpan, Timing, Energy, Noise, Conductivity, Humidity,
}

/// <summary>Describes a sensor id once per session so rows can stay a map of id to value.
/// <see cref="Id"/> is the LibreHardwareMonitor identifier (suffixed "#n" when the library
/// emits the same identifier twice under one hardware node) or a synthetic /nvml/... or
/// /pdh/... id; <see cref="Name"/> is display-only.</summary>
public sealed record SensorMeta(
    string Id,
    string Hardware,
    string HardwareName,
    string HardwareType,
    string Name,
    SensorType SensorType,
    string Unit);

/// <summary>Every sensor read at one instant. A missing key is "no reading this tick".</summary>
public sealed record SensorRow(long Qpc, Dictionary<string, float> Values);

/// <summary>One-second fold of full-rate rows older than ten minutes (plan section 6).</summary>
public sealed record SensorSummaryRow(
    long QpcStart,
    long QpcEnd,
    Dictionary<string, float> Min,
    Dictionary<string, float> Max,
    Dictionary<string, float> Mean);

/// <summary>GET /sensors/window: full-rate <see cref="Rows"/> when the window fits in the
/// ten-minute full-rate buffer, otherwise <see cref="Summaries"/>; the other list is empty.</summary>
public sealed record SensorWindow(
    int Seconds,
    long QpcNow,
    IReadOnlyList<SensorRow> Rows,
    IReadOnlyList<SensorSummaryRow> Summaries);

/// <summary>One SSE "tick" event on GET /stream, 2 Hz: the latest value of every sensor and
/// the live GPU facts.</summary>
public sealed record Tick(long Qpc, Dictionary<string, float> Sensors, IReadOnlyList<GpuFacts> Gpu);
