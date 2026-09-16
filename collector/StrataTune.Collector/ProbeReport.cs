using System.Diagnostics;
using System.Globalization;
using StrataTune.Shared;

namespace StrataTune.Collector;

/// <summary>The --probe verb: one plain-text page proving what this machine's sensors return.
/// Exit codes: 0 ok, 1 a block threw, 2 not elevated, 3 NVML unavailable, 4 PawnIO is not
/// usable and the CPU and board numbers would be zeros rather than readings.</summary>
internal static class ProbeReport
{
    private const int Ok = 0, BlockFailed = 1, NotElevated = 2, NoNvml = 3, NoPawnIo = 4;

    public static int Write(TextWriter w)
    {
        var pawnIo = PawnIoDevice.Check();

        w.WriteLine("Strata Tune collector probe");
        w.WriteLine($"Time           {DateTimeOffset.Now:O}");
        w.WriteLine($"Process        pid {Environment.ProcessId}, {Environment.ProcessPath}");
        w.WriteLine($"QPC frequency  {Stopwatch.Frequency} Hz");
        w.WriteLine($"Elevated       {Lhm.IsElevated}");
        w.WriteLine($"PawnIO         {(Lhm.PawnIoInstalled ? $"registered, {Lhm.PawnIoVersion}" : "NOT registered")}");
        w.WriteLine($"PawnIO device  {pawnIo.Detail}");
        w.WriteLine();

        if (!Lhm.IsElevated)
        {
            w.WriteLine("Not elevated: PawnIO only opens for administrators and LibreHardwareMonitor would then report zeros as if they were readings. Run this as administrator.");
            return NotElevated;
        }

        // The registry entry behind PawnIo.IsInstalled says nothing about whether the driver
        // is running, so the handle itself is what gets checked before anything is read.
        if (!pawnIo.Usable)
        {
            w.WriteLine("PawnIO's device did not open. LibreHardwareMonitor's register reads would silently return zeros: CPU temperature 0, package power 0, no super-IO chip, no exception. Install or start PawnIO (https://pawnio.eu) and run this again.");
            return NoPawnIo;
        }

        var lhm = Attempt(w, "LibreHardwareMonitor (pass 1 → pass 2, 600 ms apart)", Lhm.Probe, WriteTree);
        var gpus = Attempt(w, "NVML", Nvml.Read, WriteGpus);
        var pdh = Attempt(w, "PDH (two samples 1 s apart)", Pdh.Read, WritePdh);

        var zeros = lhm is null ? null : SilentZeros(lhm);
        if (lhm is not null)
        {
            WriteSanity(w, lhm, zeros);
            Heading(w, "LibreHardwareMonitor GetReport() (serials, the raw SMBIOS table and PCI instance ids redacted)");
            w.WriteLine(lhm.Report);
        }

        if (gpus is null)
            return NoNvml;
        if (lhm is null || pdh is null)
            return BlockFailed;
        return zeros is null ? Ok : NoPawnIo;
    }

    // A block that throws is reported in place so the other blocks still print.
    private static T? Attempt<T>(TextWriter w, string title, Func<T> read, Action<TextWriter, T> print) where T : class
    {
        Heading(w, title);
        try
        {
            var value = read();
            print(w, value);
            return value;
        }
        catch (Exception e)
        {
            w.WriteLine($"FAILED: {e.GetType().Name}: {e.Message}");
            return null;
        }
        finally
        {
            w.WriteLine();
        }
    }

    /// <summary>The signature of a driver that answered but read nothing: the handle opens and
    /// every register still comes back 0. Returns what is wrong, or null when the tree looks
    /// like real readings.</summary>
    private static string? SilentZeros(LhmProbe probe)
    {
        var cpu = probe.Hardware.FirstOrDefault(h => h.Type == "Cpu");
        if (cpu is null)
            return "LibreHardwareMonitor found no CPU node";

        var temperatures = cpu.Sensors.Where(s => s.Meta.SensorType == "Temperature").ToList();
        if (temperatures.Count == 0)
            return "the CPU node reports no temperature at all";

        return temperatures.Any(t => !IsZero(t.First) || !IsZero(t.Second))
            ? null
            : "every CPU temperature read 0 on both passes";
    }

    private static bool IsZero(float? value) => value is null || float.IsNaN(value.Value) || value.Value == 0f;

    private static void WriteSanity(TextWriter w, LhmProbe probe, string? zeros)
    {
        Heading(w, "Sensor sanity");
        w.WriteLine($"CPU temperature  {zeros ?? "non-zero on at least one pass"}");
        w.WriteLine($"Super-IO chip    {(probe.Hardware.Any(h => h.Type == "SuperIO") ? "present" : "none found — a board LHM has no mapping for reports no fans and no board temperatures")}");
        if (zeros is not null)
            w.WriteLine("Treat this run as no data (exit 4), not as a machine that runs at 0 °C.");
        w.WriteLine();
    }

    private static void WriteTree(TextWriter w, LhmProbe probe)
    {
        foreach (var hw in probe.Hardware)
        {
            var indent = new string(' ', hw.Depth * 2);
            w.WriteLine($"{indent}{hw.Name}  [{hw.Type}]  {hw.Id}");
            foreach (var (meta, first, second, min, max) in hw.Sensors)
                w.WriteLine(
                    $"{indent}  {meta.Id,-34} {meta.SensorType,-12} {meta.Name,-26} " +
                    $"{Num(first),10} → {Num(second),-10} {meta.Unit,-5} " +
                    $"min {Num(min),10}  max {Num(max),10}");
        }
        w.WriteLine();
        w.WriteLine($"{probe.Hardware.Count} hardware nodes, {probe.FirstPass.Count} sensors ({probe.Meta.Count} distinct ids), " +
                    $"QPC {probe.FirstPass[0].Qpc} → {probe.SecondPass[0].Qpc} " +
                    $"({(probe.SecondPass[0].Qpc - probe.FirstPass[0].Qpc) * 1000.0 / Stopwatch.Frequency:0} ms apart)");
        if (probe.DuplicateIds.Count > 0)
            w.WriteLine($"DUPLICATE identifiers (the stream layer must disambiguate): {string.Join(", ", probe.DuplicateIds)}");
    }

    private static void WriteGpus(TextWriter w, IReadOnlyList<GpuFacts> gpus)
    {
        foreach (var g in gpus)
        {
            w.WriteLine($"GPU {g.Index}         {g.Name}");
            w.WriteLine($"  Driver        {g.Driver}");
            w.WriteLine($"  PCIe          gen {g.PcieCurrentGen} x{g.PcieCurrentWidth} of gen {g.PcieMaxGen} x{g.PcieMaxWidth} (GPU supports gen {Opt(g.GpuMaxPcieGen)})");
            w.WriteLine($"  BAR1          {Opt(g.Bar1TotalMiB)} MiB");
            w.WriteLine($"  VRAM          {g.VramUsedMiB} of {g.VramTotalMiB} MiB used");
            w.WriteLine($"  Power         {Opt(g.PowerMilliwatts)} mW, limit {Opt(g.PowerLimitMilliwatts)} mW");
            w.WriteLine($"  Clocks        SM {g.SmClockMHz} MHz, MEM {g.MemClockMHz} MHz");
            w.WriteLine($"  Temperature   {g.TemperatureC} °C");
            w.WriteLine($"  Utilisation   GPU {Opt(g.GpuUtilPercent)} %, memory {Opt(g.MemUtilPercent)} %");
            w.WriteLine($"  Clocks event  {(g.ClocksEventReasons is ulong bits ? $"0x{bits:X} → {string.Join(", ", g.ClocksEventReasonNames)}" : Opt(g.ClocksEventReasons))}");
        }
    }

    private static void WritePdh(TextWriter w, PdhReadings pdh)
    {
        w.WriteLine("PhysicalDisk / Current Disk Queue Length");
        foreach (var d in pdh.DiskQueue)
            w.WriteLine($"  {d.Instance,-16} {Num(d.First),6} → {Num(d.Second)}");
        w.WriteLine("Process V2 / % Processor Time");
        w.WriteLine($"  {pdh.ProcessInstance,-30} {Num(pdh.OwnCpuPercent)} % of {Environment.ProcessorCount} logical CPUs");
    }

    private static void Heading(TextWriter w, string title)
    {
        w.WriteLine($"== {title}");
    }

    private static string Num(float? value) =>
        value is null || float.IsNaN(value.Value) ? "—" : value.Value.ToString("0.###", CultureInfo.InvariantCulture);

    // A field this card or driver does not support prints as such, never as 0.
    private static string Opt<T>(T? value) where T : struct =>
        value is null ? "not supported" : value.Value.ToString() ?? "";
}
