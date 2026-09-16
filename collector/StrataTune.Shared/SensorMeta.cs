namespace StrataTune.Shared;

/// <summary>Describes a sensor id once per session so samples can stay three fields wide.
/// <see cref="Id"/> is the LibreHardwareMonitor identifier (or a synthetic /nvml/... id);
/// <see cref="Name"/> is display-only and may be renamed by the user in other tools.</summary>
public sealed record SensorMeta(
    string Id,
    string Hardware,
    string HardwareType,
    string Name,
    string SensorType,
    string Unit);
