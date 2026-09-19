using System.Diagnostics;
using System.Security.Principal;
using LibreHardwareMonitor.Hardware;
using LibreHardwareMonitor.PawnIo;
using StrataTune.Shared;

namespace StrataTune.Collector;

internal sealed record LhmSensorRow(SensorMeta Meta, float? First, float? Second, float? Min, float? Max);

/// <summary>One node of the hardware tree with its own sensors; the list is depth-first so a
/// report can print it without rebuilding parent links.</summary>
internal sealed record LhmHardware(string Id, string Name, string Type, int Depth, IReadOnlyList<LhmSensorRow> Sensors);

internal sealed record LhmProbe(
    IReadOnlyList<LhmHardware> Hardware,
    long Qpc1,
    long Qpc2,
    IReadOnlyList<string> SuffixedIds,
    string Report);

/// <summary>A sensor paired with its stream id (<see cref="SensorIds"/>).</summary>
internal sealed record LhmSensor(ISensor Sensor, SensorMeta Meta);

/// <summary>LibreHardwareMonitor wrapper. Without admin and a working PawnIO the library
/// returns zeros rather than failing, so callers must pass <see cref="IsElevated"/> and
/// <see cref="PawnIoDevice.Check"/> before believing anything it returns;
/// <see cref="PawnIoInstalled"/> is only the registry entry and proves nothing on its own.</summary>
internal static class Lhm
{
    // Package power is a delta of the RAPL-style energy accumulator: the first pass is 0/NaN
    // and the library wants at least 500 ms between the two reads it differences.
    public static readonly TimeSpan MinimumGap = TimeSpan.FromMilliseconds(500);
    private static readonly TimeSpan PassGap = TimeSpan.FromMilliseconds(600);

    public static bool IsElevated =>
        new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator);

    public static bool PawnIoInstalled => PawnIo.IsInstalled;

    public static Version? PawnIoVersion => PawnIo.IsInstalled ? PawnIo.Version : null;

    /// <summary>Opens the driver and SMBIOS with no hardware group: the sampler adds the
    /// groups in stages afterwards (the library adds a group live once it is open), so the
    /// service answers before the slowest group is in.</summary>
    public static Computer OpenEmpty()
    {
        var computer = new Computer();
        computer.Open();
        return computer;
    }

    /// <summary>Opens the whole tree at once, for the probe. The CPU and board readers go
    /// through PawnIO; when its device will not open they are left out rather than left to
    /// report zeros.</summary>
    public static Computer Open(bool pawnIoUsable)
    {
        var computer = new Computer
        {
            IsCpuEnabled = pawnIoUsable,
            IsMotherboardEnabled = pawnIoUsable,
            IsGpuEnabled = true,
            IsMemoryEnabled = true,
            IsBatteryEnabled = true,
            IsStorageEnabled = true,
        };
        computer.Open();
        return computer;
    }

    public static void Update(Computer computer) => computer.Accept(UpdateVisitor.Instance);

    /// <summary>Where a hardware node's failed update is reported; the service points it at
    /// its log, the probe leaves it unset.</summary>
    public static Action<string>? ReportNodeFailure { get; set; }

    public static LhmProbe Probe()
    {
        var computer = Open(pawnIoUsable: true);
        try
        {
            Update(computer);
            var qpc1 = Stopwatch.GetTimestamp();
            var first = new Dictionary<ISensor, float?>(ReferenceEqualityComparer.Instance);
            foreach (var s in SensorIds.Enumerate(computer))
                first[s.Sensor] = s.Sensor.Value;
            Thread.Sleep(PassGap);
            Update(computer);
            var qpc2 = Stopwatch.GetTimestamp();

            var hardware = new List<LhmHardware>();
            foreach (var hw in computer.Hardware)
                Describe(hw, 0, first, hardware);

            var suffixed = hardware.SelectMany(h => h.Sensors)
                .Select(r => r.Meta.Id).Where(id => id.Contains('#')).ToList();
            return new LhmProbe(hardware, qpc1, qpc2, suffixed, Redact.Report(computer.GetReport()));
        }
        finally
        {
            computer.Close();
        }
    }

    private static void Describe(IHardware hw, int depth, Dictionary<ISensor, float?> first, List<LhmHardware> into)
    {
        var rows = SensorIds.ForHardware(hw)
            .Select(s => new LhmSensorRow(s.Meta, first.GetValueOrDefault(s.Sensor), s.Sensor.Value, s.Sensor.Min, s.Sensor.Max))
            .ToList();
        into.Add(new LhmHardware(hw.Identifier.ToString(), Printable.Text(hw.Name), hw.HardwareType.ToString(), depth, rows));
        foreach (var sub in hw.SubHardware)
            Describe(sub, depth + 1, first, into);
    }

    public static Shared.SensorType Type(LibreHardwareMonitor.Hardware.SensorType type) =>
        Enum.TryParse<Shared.SensorType>(type.ToString(), out var parsed) ? parsed : Shared.SensorType.Factor;

    public static string Unit(LibreHardwareMonitor.Hardware.SensorType type) => type switch
    {
        LibreHardwareMonitor.Hardware.SensorType.Voltage => "V",
        LibreHardwareMonitor.Hardware.SensorType.Current => "A",
        LibreHardwareMonitor.Hardware.SensorType.Power => "W",
        LibreHardwareMonitor.Hardware.SensorType.Clock => "MHz",
        LibreHardwareMonitor.Hardware.SensorType.Temperature => "°C",
        LibreHardwareMonitor.Hardware.SensorType.Load
            or LibreHardwareMonitor.Hardware.SensorType.Control
            or LibreHardwareMonitor.Hardware.SensorType.Level
            or LibreHardwareMonitor.Hardware.SensorType.Humidity => "%",
        LibreHardwareMonitor.Hardware.SensorType.Frequency => "Hz",
        LibreHardwareMonitor.Hardware.SensorType.Fan => "RPM",
        LibreHardwareMonitor.Hardware.SensorType.Flow => "L/h",
        LibreHardwareMonitor.Hardware.SensorType.Factor => "",
        LibreHardwareMonitor.Hardware.SensorType.Data => "GB",
        LibreHardwareMonitor.Hardware.SensorType.SmallData => "MB",
        LibreHardwareMonitor.Hardware.SensorType.Throughput => "B/s",
        LibreHardwareMonitor.Hardware.SensorType.TimeSpan => "s",
        LibreHardwareMonitor.Hardware.SensorType.Timing => "ns",
        LibreHardwareMonitor.Hardware.SensorType.Energy => "mWh",
        LibreHardwareMonitor.Hardware.SensorType.Noise => "dBA",
        LibreHardwareMonitor.Hardware.SensorType.Conductivity => "µS/cm",
        _ => "",
    };

    /// <summary>One node's failed update (a storage device that went away, an NVAPI call that
    /// threw) costs that node's readings for the tick, not the whole tree's: the other
    /// nodes are still visited. Each failing node is reported once a minute.</summary>
    private sealed class UpdateVisitor : IVisitor
    {
        public static readonly UpdateVisitor Instance = new();

        private static readonly TimeSpan ReportGap = TimeSpan.FromMinutes(1);
        private readonly Dictionary<string, DateTimeOffset> _reported = new(StringComparer.Ordinal);

        public void VisitComputer(IComputer computer) => computer.Traverse(this);

        public void VisitHardware(IHardware hardware)
        {
            try
            {
                hardware.Update();
            }
            catch (Exception e)
            {
                Report(hardware, e);
            }
            // A board node whose own update failed still has its super-IO chip beneath it.
            foreach (var sub in hardware.SubHardware)
                sub.Accept(this);
        }

        private void Report(IHardware hardware, Exception e)
        {
            var id = hardware.Identifier.ToString();
            var now = DateTimeOffset.UtcNow;
            lock (_reported)
            {
                if (now - _reported.GetValueOrDefault(id, DateTimeOffset.MinValue) < ReportGap)
                    return;
                _reported[id] = now;
            }
            ReportNodeFailure?.Invoke($"lhm: {id} ({Printable.Text(hardware.Name)}) update failed: {e.GetType().Name}: {e.Message}");
        }

        public void VisitSensor(ISensor sensor) { }

        public void VisitParameter(IParameter parameter) { }
    }
}
