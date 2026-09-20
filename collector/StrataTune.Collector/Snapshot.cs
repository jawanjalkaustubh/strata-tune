using System.Runtime.InteropServices;
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
            disks, Storage.Volumes(disks, log), null,
            Adapters(log), Battery(log));
    }

    private const string DisplayClassKey = @"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}";

    // The name a processor's own graphics carry: AMD's "Radeon(TM) Graphics" / "Radeon 780M",
    // Intel's UHD / Iris / "Arc Graphics" (the tile, not an Arc A- or B-series card).
    [GeneratedRegex(@"Radeon\(TM\) Graphics|Radeon Graphics$|Radeon (Vega|6\d0M|7\d0M|8\d0M|8\d0S|610M)|Intel\(R\) (UHD|HD|Iris|Arc\(TM\) Graphics)|Intel Arc Graphics", RegexOptions.IgnoreCase)]
    private static partial Regex IntegratedName();

    /// <summary>Every display adapter, from Win32_VideoController with the dedicated memory
    /// read from the display class key whose DriverDesc matches the adapter's name (the WMI
    /// field is 32-bit). One failed read leaves the adapter with 0 MiB, never the list empty.</summary>
    private static IReadOnlyList<DisplayAdapter> Adapters(Log log)
    {
        var memoryByDesc = new Dictionary<string, long>(StringComparer.OrdinalIgnoreCase);
        try
        {
            using var cls = Registry.LocalMachine.OpenSubKey(DisplayClassKey);
            foreach (var sub in cls?.GetSubKeyNames() ?? [])
            {
                // One subkey of the class (the first laptop had one) refuses even an administrator
                // (SecurityException); it is skipped, not the loop, so the cards before and after it keep their figure.
                try
                {
                    using var key = cls!.OpenSubKey(sub);
                    var desc = key?.GetValue("DriverDesc")?.ToString();
                    if (string.IsNullOrEmpty(desc) || key!.GetValue("HardwareInformation.qwMemorySize") is not long bytes || bytes <= 0)
                        continue;
                    // Two keys for one description (a driver update leaves the old one) keep the larger figure.
                    memoryByDesc[desc] = Math.Max(memoryByDesc.GetValueOrDefault(desc), bytes / MiB);
                }
                catch (Exception e) when (e is System.Security.SecurityException or UnauthorizedAccessException)
                {
                    // Expected on some keys; nothing to log every snapshot.
                }
            }
        }
        catch (Exception e)
        {
            log.Write($"snapshot: display class key unreadable, adapter memory unknown: {e.GetType().Name}: {e.Message}");
        }
        return Wmi.Query(Wmi.Cimv2,
            "SELECT Name, PNPDeviceID, DriverVersion, DriverDate, AdapterRAM FROM Win32_VideoController",
            r =>
            {
                var name = Printable.Text(Wmi.Text(r, "Name"));
                var pnp = Wmi.Text(r, "PNPDeviceID");
                var vendor = pnp.Contains("VEN_10DE", StringComparison.OrdinalIgnoreCase) ? "nvidia"
                    : pnp.Contains("VEN_1002", StringComparison.OrdinalIgnoreCase) ? "amd"
                    : pnp.Contains("VEN_8086", StringComparison.OrdinalIgnoreCase) ? "intel"
                    : "other";
                var dedicated = memoryByDesc.GetValueOrDefault(name);
                if (dedicated == 0)
                    dedicated = Wmi.Number(r, "AdapterRAM") / MiB;
                var integrated = dedicated < 1024 || IntegratedName().IsMatch(name);
                return new DisplayAdapter(name, vendor, dedicated, Wmi.Text(r, "DriverVersion"), Wmi.Date(r, "DriverDate"), integrated);
            }, log)
            // A virtual or remote-display adapter (no PCI vendor) goes last, never first.
            .OrderBy(a => a.Vendor == "other").ThenByDescending(a => a.DedicatedMiB).ToList();
    }

    private static BatteryInfo Battery(Log log)
    {
        try
        {
            if (!GetSystemPowerStatus(out var status))
                return new BatteryInfo(false, true, null);
            // BatteryFlag 128 is "no system battery"; 255 is unknown. ACLineStatus 1 is online, 255 unknown (read as online).
            var present = status.BatteryFlag != 128 && status.BatteryFlag != 255;
            var onAc = status.AcLineStatus != 0;
            int? percent = present && status.BatteryLifePercent <= 100 ? status.BatteryLifePercent : null;
            return new BatteryInfo(present, onAc, percent);
        }
        catch (Exception e)
        {
            log.Write($"snapshot: power status unreadable: {e.GetType().Name}: {e.Message}");
            return new BatteryInfo(false, true, null);
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SystemPowerStatus
    {
        public byte AcLineStatus;
        public byte BatteryFlag;
        public byte BatteryLifePercent;
        public byte SystemStatusFlag;
        public int BatteryLifeTime;
        public int BatteryFullLifeTime;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetSystemPowerStatus(out SystemPowerStatus status);

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
