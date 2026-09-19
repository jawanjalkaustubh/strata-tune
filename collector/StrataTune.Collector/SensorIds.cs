using LibreHardwareMonitor.Hardware;
using StrataTune.Shared;

namespace StrataTune.Collector;

/// <summary>Stream ids for LibreHardwareMonitor sensors. The library does not promise unique
/// identifiers — on the dev box the 5090 emits /gpu-nvidia/0/voltage/0 twice (GPU Core
/// Voltage and 12VHPWR Pin 1) and /gpu-nvidia/0/load/3 twice — and plan section 6 keys
/// streams on the identifier. A repeat within one hardware node gets "#n" appended, n
/// counting from 1 in enumeration order, which the library keeps fixed for a given machine,
/// so the ids are the same on every tick and every run.</summary>
internal static class SensorIds
{
    public static IEnumerable<LhmSensor> Enumerate(IComputer computer) =>
        computer.Hardware.SelectMany(All);

    public static IEnumerable<LhmSensor> ForHardware(IHardware hw)
    {
        var hwId = hw.Identifier.ToString();
        var hwName = Printable.Text(hw.Name);
        var type = hw.HardwareType.ToString();
        var seen = new Dictionary<string, int>();
        foreach (var s in hw.Sensors)
        {
            var raw = s.Identifier.ToString();
            var n = seen.GetValueOrDefault(raw);
            seen[raw] = n + 1;
            var id = n == 0 ? raw : $"{raw}#{n}";
            // Names come from the hardware itself (SPD strings, super-IO tables) and are not
            // always clean text; identifiers are the library's and are left alone.
            yield return new LhmSensor(s, new SensorMeta(
                id, hwId, hwName, type, Printable.Text(s.Name), Lhm.Type(s.SensorType), Lhm.Unit(s.SensorType)));
        }
    }

    /// <summary>How many sensors the tree holds right now, without building anything.</summary>
    public static int Count(IComputer computer) => computer.Hardware.Sum(CountIn);

    private static IEnumerable<LhmSensor> All(IHardware hw) =>
        ForHardware(hw).Concat(hw.SubHardware.SelectMany(All));

    private static int CountIn(IHardware hw) => hw.Sensors.Length + hw.SubHardware.Sum(CountIn);
}
