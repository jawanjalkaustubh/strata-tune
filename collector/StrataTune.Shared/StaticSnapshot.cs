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
    IReadOnlyList<OllamaModel>? Ollama,
    IReadOnlyList<DisplayAdapter> Adapters,
    BatteryInfo Battery);

/// <summary>Every display adapter Windows knows, NVIDIA or not (<see cref="StaticSnapshot.Gpus"/>
/// is NVML's list, so an AMD or Intel card is only ever seen here). <see cref="DedicatedMiB"/>
/// is the driver's own figure from the display class registry key, because
/// Win32_VideoController.AdapterRAM is a 32-bit field that reads 4 GB on any bigger card.
/// <see cref="Integrated"/> is a heuristic (under 1 GiB of dedicated memory, or the name a
/// processor's own graphics carry), the difference between "no discrete GPU" and a discrete
/// card the app has no driver API for. Seen on the first laptop (an ASUS GA402RJ): the RX 6700S
/// with 8176 MiB beside the 6900HS's Radeon Graphics with 512.</summary>
public sealed record DisplayAdapter(
    string Name,
    string Vendor,
    long DedicatedMiB,
    string DriverVersion,
    string? DriverDate,
    bool Integrated);

/// <summary>GetSystemPowerStatus at capture time: whether the machine runs from the wall or
/// the battery, which is what an efficiency power mode on a laptop means (plan 17c). Percent
/// is null when Windows does not know it.</summary>
public sealed record BatteryInfo(bool Present, bool OnAc, int? Percent);

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
