using System.Text.Json.Serialization;

namespace StrataTune.Shared;

/// <summary>GET /snapshot: the static configuration the audit rules read (plan sections 6
/// and 8). Every block is filled independently, so one failed WMI query leaves that block
/// empty rather than failing the whole capture.</summary>
public sealed record StaticSnapshot(
    string CapturedAt,
    OsInfo Os,
    ChassisInfo Chassis,
    CpuInfo Cpu,
    MotherboardInfo Motherboard,
    RamInfo Ram,
    IReadOnlyList<GpuFacts> Gpus,
    GpuDriverInfo GpuDriver,
    PowerPlanInfo PowerPlan,
    IReadOnlyList<PhysicalDisk> Disks,
    IReadOnlyList<Volume> Volumes,
    IReadOnlyList<OllamaModel>? Ollama);

public sealed record OsInfo(string Caption, string Build);

public sealed record ChassisInfo(bool IsLaptop, IReadOnlyList<int> ChassisTypes);

public sealed record CpuInfo(string Name, int Family, int Model, int Cores, int Logical, int MaxClockMhz);

public sealed record MotherboardInfo(string Manufacturer, string Product, string BiosVersion, string BiosDate);

public sealed record RamInfo(long TotalMiB, IReadOnlyList<RamModule> Modules);

/// <summary><see cref="ReportedMts"/> is Win32_PhysicalMemory.Speed, which many boards fill
/// with the configured speed rather than the SPD rating (docs/dependencies.md).</summary>
public sealed record RamModule(
    string Slot,
    string PartNumber,
    string Manufacturer,
    long CapacityMiB,
    int ConfiguredMts,
    int ReportedMts);

public enum MediaType
{
    [JsonStringEnumMemberName("HDD")] Hdd,
    [JsonStringEnumMemberName("SSD")] Ssd,
    [JsonStringEnumMemberName("SCM")] Scm,
    Unspecified,
}

public sealed record PhysicalDisk(string DeviceId, string FriendlyName, MediaType MediaType, string BusType, long SizeBytes);

public sealed record Volume(
    string Letter,
    string Label,
    string FileSystem,
    long SizeBytes,
    long FreeBytes,
    bool IsBoot,
    string? DiskDeviceId);

public sealed record OllamaModel(string Name, long SizeBytes, long SizeVramBytes);

public sealed record GpuDriverInfo(string Version, string? Date);

/// <summary><see cref="OverlayGuid"/> is the Windows 10/11 power-mode slider (Best performance
/// and friends), an overlay the active-scheme API never reports; null when no overlay is set
/// or the API is absent.</summary>
public sealed record PowerPlanInfo(string Guid, string Name, string? OverlayGuid);
