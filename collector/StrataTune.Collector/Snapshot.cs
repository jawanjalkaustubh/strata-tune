using System.Text.RegularExpressions;
using Microsoft.Win32;
using StrataTune.Shared;

namespace StrataTune.Collector;

/// <summary>GET /snapshot: the static inputs of the audit (plan sections 7 and 8), each block
/// read on its own so a failed WMI class empties that block and nothing else.</summary>
internal static partial class Snapshot
{
    private const long MiB = 1L << 20;
    private const string CurrentVersionKey = @"SOFTWARE\Microsoft\Windows NT\CurrentVersion";

    // SMBIOS chassis types that mean "portable": Portable, Laptop, Notebook, Sub Notebook,
    // Tablet, Convertible, Detachable.
    private static readonly int[] LaptopChassis = [8, 9, 10, 14, 30, 31, 32];

    public static async Task<StaticSnapshot> CaptureAsync(IReadOnlyList<GpuFacts> gpus, Log log)
    {
        var ollama = Ollama.ModelsAsync();
        var snapshot = await Task.Run(() => Capture(gpus, log));
        return snapshot with { Ollama = await ollama };
    }

    private static StaticSnapshot Capture(IReadOnlyList<GpuFacts> gpus, Log log)
    {
        var disks = Storage.Disks(log);
        return new StaticSnapshot(
            DateTimeOffset.UtcNow.ToString("O"),
            Os(log), Chassis(log), Cpu(log), Board(log), Ram(log),
            gpus, GpuDriver(gpus, log), PowerPlan.Read(log),
            disks, Storage.Volumes(disks, log), null);
    }

    private static OsInfo Os(Log log)
    {
        using var key = Registry.LocalMachine.OpenSubKey(CurrentVersionKey);
        var build = key?.GetValue("CurrentBuildNumber")?.ToString() ?? "";
        if (key?.GetValue("UBR") is { } ubr)
            build = $"{build}.{ubr}";
        // ProductName still says "Windows 10" on Windows 11, so the caption comes from WMI and
        // the registry only backs it up.
        var caption = Wmi.Query(Wmi.Cimv2, "SELECT Caption FROM Win32_OperatingSystem", r => Wmi.Text(r, "Caption"), log).FirstOrDefault();
        if (string.IsNullOrEmpty(caption))
            caption = key?.GetValue("ProductName")?.ToString() ?? "";
        return new OsInfo(caption, build);
    }

    // SMBIOS decides; a battery only stands in when the chassis type is missing or one of
    // the two "Other"/"Unknown" codes, because a desktop with a USB UPS reports a battery too.
    private static ChassisInfo Chassis(Log log)
    {
        var types = Wmi.Query(Wmi.Cimv2, "SELECT ChassisTypes FROM Win32_SystemEnclosure",
                r => (r["ChassisTypes"] as ushort[] ?? []).Select(t => (int)t).ToList(), log)
            .SelectMany(t => t).ToList();
        if (types.Any(t => t > 2))
            return new ChassisInfo(types.Any(LaptopChassis.Contains), types);
        var battery = Wmi.Query(Wmi.Cimv2, "SELECT DeviceID FROM Win32_Battery", _ => true, log).Count > 0;
        return new ChassisInfo(battery, types);
    }

    private static CpuInfo Cpu(Log log) =>
        Wmi.Query(Wmi.Cimv2,
            "SELECT Name, Caption, NumberOfCores, NumberOfLogicalProcessors, MaxClockSpeed FROM Win32_Processor",
            r =>
            {
                // Caption reads "AMD64 Family 26 Model 68 Stepping 0": the CPUID family and
                // model, which the Family property (an SMBIOS enum) is not.
                var ids = FamilyModel().Match(Wmi.Text(r, "Caption"));
                return new CpuInfo(
                    Wmi.Text(r, "Name"),
                    ids.Success ? int.Parse(ids.Groups[1].Value) : 0,
                    ids.Success ? int.Parse(ids.Groups[2].Value) : 0,
                    (int)Wmi.Number(r, "NumberOfCores"),
                    (int)Wmi.Number(r, "NumberOfLogicalProcessors"),
                    (int)Wmi.Number(r, "MaxClockSpeed"));
            }, log).FirstOrDefault()
        ?? new CpuInfo("", 0, 0, 0, Environment.ProcessorCount, 0);

    private static MotherboardInfo Board(Log log)
    {
        var board = Wmi.Query(Wmi.Cimv2, "SELECT Manufacturer, Product FROM Win32_BaseBoard",
            r => (Manufacturer: Wmi.Text(r, "Manufacturer"), Product: Wmi.Text(r, "Product")), log).FirstOrDefault();
        var bios = Wmi.Query(Wmi.Cimv2, "SELECT SMBIOSBIOSVersion, ReleaseDate FROM Win32_BIOS",
            r => (Version: Wmi.Text(r, "SMBIOSBIOSVersion"), Date: Wmi.Date(r, "ReleaseDate") ?? ""), log).FirstOrDefault();
        return new MotherboardInfo(board.Manufacturer ?? "", board.Product ?? "", bios.Version ?? "", bios.Date ?? "");
    }

    private static RamInfo Ram(Log log)
    {
        var modules = Wmi.Query(Wmi.Cimv2,
            "SELECT DeviceLocator, PartNumber, Manufacturer, Capacity, ConfiguredClockSpeed, Speed FROM Win32_PhysicalMemory",
            r => new RamModule(
                Wmi.Text(r, "DeviceLocator"), Wmi.Text(r, "PartNumber"), Wmi.Text(r, "Manufacturer"),
                Wmi.Number(r, "Capacity") / MiB, (int)Wmi.Number(r, "ConfiguredClockSpeed"), (int)Wmi.Number(r, "Speed")), log);
        var total = modules.Sum(m => m.CapacityMiB);
        if (total == 0)
            total = Wmi.Query(Wmi.Cimv2, "SELECT TotalPhysicalMemory FROM Win32_ComputerSystem",
                r => Wmi.Number(r, "TotalPhysicalMemory") / MiB, log).FirstOrDefault();
        return new RamInfo(total, modules);
    }

    // The version is NVML's own spelling ("616.92") when a card answered; the install date
    // only exists in the signed-driver table.
    private static GpuDriverInfo GpuDriver(IReadOnlyList<GpuFacts> gpus, Log log)
    {
        var drivers = Wmi.Query(Wmi.Cimv2,
            "SELECT DeviceName, Manufacturer, DriverVersion, DriverDate FROM Win32_PnPSignedDriver WHERE DeviceClass='DISPLAY'",
            r => (Name: Wmi.Text(r, "DeviceName"), Maker: Wmi.Text(r, "Manufacturer"), Version: Wmi.Text(r, "DriverVersion"), Date: Wmi.Date(r, "DriverDate")), log);
        var pick = drivers.FirstOrDefault(d => d.Maker.Contains("NVIDIA", StringComparison.OrdinalIgnoreCase) || d.Name.Contains("NVIDIA", StringComparison.OrdinalIgnoreCase));
        if (pick == default)
            pick = drivers.FirstOrDefault();
        var version = gpus.Count > 0 ? gpus[0].Driver : pick.Version ?? "";
        return new GpuDriverInfo(version, pick.Date);
    }

    [GeneratedRegex(@"Family (\d+) Model (\d+)")]
    private static partial Regex FamilyModel();
}
