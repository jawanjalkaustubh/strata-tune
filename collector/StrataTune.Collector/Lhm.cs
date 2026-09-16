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
    IReadOnlyDictionary<string, SensorMeta> Meta,
    IReadOnlyList<SensorSample> FirstPass,
    IReadOnlyList<SensorSample> SecondPass,
    IReadOnlyList<string> DuplicateIds,
    string Report);

/// <summary>LibreHardwareMonitor wrapper. Without admin and a working PawnIO the library
/// returns zeros rather than failing, so callers must pass <see cref="IsElevated"/> and
/// <see cref="PawnIoDevice.Check"/> before believing anything <see cref="Probe"/> returns;
/// <see cref="PawnIoInstalled"/> is only the registry entry and proves nothing on its own.</summary>
internal static class Lhm
{
    // Package power is a delta of the RAPL-style energy accumulator: the first pass is 0/NaN
    // and the library wants at least 500 ms between the two reads it differences.
    private static readonly TimeSpan PassGap = TimeSpan.FromMilliseconds(600);

    public static bool IsElevated =>
        new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator);

    public static bool PawnIoInstalled => PawnIo.IsInstalled;

    public static Version? PawnIoVersion => PawnIo.IsInstalled ? PawnIo.Version : null;

    public static LhmProbe Probe()
    {
        var computer = new Computer
        {
            IsCpuEnabled = true,
            IsMotherboardEnabled = true,
            IsGpuEnabled = true,
            IsMemoryEnabled = true,
            IsStorageEnabled = true,
        };
        computer.Open();
        try
        {
            var visitor = new UpdateVisitor();
            computer.Accept(visitor);
            var qpc1 = Stopwatch.GetTimestamp();
            var first = new Dictionary<ISensor, float?>(ReferenceEqualityComparer.Instance);
            foreach (var s in AllSensors(computer.Hardware))
                first[s] = s.Value;
            Thread.Sleep(PassGap);
            computer.Accept(visitor);
            var qpc2 = Stopwatch.GetTimestamp();

            var hardware = new List<LhmHardware>();
            foreach (var hw in computer.Hardware)
                Describe(hw, 0, first, hardware);

            // The library does not promise unique identifiers (the NVIDIA GPU emits two
            // /gpu-nvidia/0/voltage/0 sensors); the stream layer keys on them, so say so.
            var meta = new Dictionary<string, SensorMeta>();
            var duplicates = new List<string>();
            var rows = hardware.SelectMany(h => h.Sensors).ToList();
            foreach (var row in rows)
                if (!meta.TryAdd(row.Meta.Id, row.Meta))
                    duplicates.Add(row.Meta.Id);

            return new LhmProbe(
                hardware, meta,
                rows.Select(r => new SensorSample(qpc1, r.Meta.Id, r.First ?? float.NaN)).ToList(),
                rows.Select(r => new SensorSample(qpc2, r.Meta.Id, r.Second ?? float.NaN)).ToList(),
                duplicates, Redact.Report(computer.GetReport()));
        }
        finally
        {
            computer.Close();
        }
    }

    private static IEnumerable<ISensor> AllSensors(IEnumerable<IHardware> hardware) =>
        hardware.SelectMany(hw => hw.Sensors.Concat(AllSensors(hw.SubHardware)));

    private static void Describe(IHardware hw, int depth, Dictionary<ISensor, float?> first, List<LhmHardware> into)
    {
        var hwId = hw.Identifier.ToString();
        var type = hw.HardwareType.ToString();
        // Names come from the hardware itself (SPD strings, super-IO tables) and are not
        // always clean text; identifiers are ours and are left alone.
        var rows = hw.Sensors.Select(s => new LhmSensorRow(
            new SensorMeta(s.Identifier.ToString(), hwId, type, Printable.Text(s.Name), s.SensorType.ToString(), Unit(s.SensorType)),
            first.GetValueOrDefault(s), s.Value, s.Min, s.Max)).ToList();
        into.Add(new LhmHardware(hwId, Printable.Text(hw.Name), type, depth, rows));
        foreach (var sub in hw.SubHardware)
            Describe(sub, depth + 1, first, into);
    }

    private static string Unit(SensorType type) => type switch
    {
        SensorType.Voltage => "V",
        SensorType.Current => "A",
        SensorType.Power => "W",
        SensorType.Clock => "MHz",
        SensorType.Temperature => "°C",
        SensorType.Load or SensorType.Control or SensorType.Level or SensorType.Humidity => "%",
        SensorType.Frequency => "Hz",
        SensorType.Fan => "RPM",
        SensorType.Flow => "L/h",
        SensorType.Factor => "",
        SensorType.Data => "GB",
        SensorType.SmallData => "MB",
        SensorType.Throughput => "B/s",
        SensorType.TimeSpan => "s",
        SensorType.Timing => "ns",
        SensorType.Energy => "mWh",
        SensorType.Noise => "dBA",
        SensorType.Conductivity => "µS/cm",
        _ => "",
    };

    private sealed class UpdateVisitor : IVisitor
    {
        public void VisitComputer(IComputer computer) => computer.Traverse(this);

        public void VisitHardware(IHardware hardware)
        {
            hardware.Update();
            foreach (var sub in hardware.SubHardware)
                sub.Accept(this);
        }

        public void VisitSensor(ISensor sensor) { }

        public void VisitParameter(IParameter parameter) { }
    }
}
