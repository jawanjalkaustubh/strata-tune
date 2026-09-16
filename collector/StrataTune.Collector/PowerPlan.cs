using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using StrataTune.Shared;

namespace StrataTune.Collector;

/// <summary>The active power scheme, through the power API first and the powercfg text as
/// the fallback (plan section 7), plus the Windows 10/11 power-mode overlay (the Settings
/// slider: Best performance, Better performance, Best power efficiency), which laptops
/// use in place of the classic High performance scheme and PowerGetActiveScheme never
/// reports.</summary>
internal static partial class PowerPlan
{
    private const uint ErrorSuccess = 0;

    [DllImport("powrprof.dll")]
    private static extern uint PowerGetActiveScheme(IntPtr rootPowerKey, out IntPtr activePolicyGuid);

    [DllImport("powrprof.dll")]
    private static extern uint PowerReadFriendlyName(
        IntPtr rootPowerKey, in Guid schemeGuid, IntPtr subGroup, IntPtr setting, byte[]? buffer, ref uint bufferSize);

    // Exported since Windows 10 1709; absent on older builds, hence the EntryPointNotFoundException path.
    [DllImport("powrprof.dll")]
    private static extern uint PowerGetEffectiveOverlayScheme(out Guid overlaySchemeGuid);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);

    public static PowerPlanInfo Read(Log log)
    {
        var overlay = Overlay(log);
        try
        {
            if (PowerGetActiveScheme(IntPtr.Zero, out var guidPointer) == ErrorSuccess)
            {
                try
                {
                    var guid = Marshal.PtrToStructure<Guid>(guidPointer);
                    return new PowerPlanInfo(guid.ToString(), FriendlyName(guid), overlay);
                }
                finally
                {
                    LocalFree(guidPointer);
                }
            }
        }
        catch (Exception e) when (e is DllNotFoundException or EntryPointNotFoundException)
        {
            log.Write($"power api: {e.Message}");
        }

        return Powercfg(log, overlay);
    }

    /// <summary>The effective overlay, lowercase; null when none is set (the Balanced slider
    /// position reads as the empty GUID) or the export does not exist.</summary>
    private static string? Overlay(Log log)
    {
        try
        {
            if (PowerGetEffectiveOverlayScheme(out var overlay) != ErrorSuccess || overlay == Guid.Empty)
                return null;
            return overlay.ToString();
        }
        catch (Exception e) when (e is DllNotFoundException or EntryPointNotFoundException)
        {
            log.Write($"power overlay api: {e.Message}");
            return null;
        }
    }

    private static string FriendlyName(Guid scheme)
    {
        uint size = 0;
        PowerReadFriendlyName(IntPtr.Zero, in scheme, IntPtr.Zero, IntPtr.Zero, null, ref size);
        if (size == 0)
            return "";
        var buffer = new byte[size];
        return PowerReadFriendlyName(IntPtr.Zero, in scheme, IntPtr.Zero, IntPtr.Zero, buffer, ref size) == ErrorSuccess
            ? Encoding.Unicode.GetString(buffer, 0, (int)size).TrimEnd('\0')
            : "";
    }

    // "Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced)". Started by full
    // path: this process is elevated, and a bare name would search its working directory.
    private static PowerPlanInfo Powercfg(Log log, string? overlay)
    {
        try
        {
            using var process = Process.Start(new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "powercfg.exe"), "/getactivescheme")
            {
                UseShellExecute = false,
                RedirectStandardOutput = true,
                CreateNoWindow = true,
            });
            var output = process?.StandardOutput.ReadToEnd() ?? "";
            process?.WaitForExit();
            var match = SchemeLine().Match(output);
            if (match.Success)
                return new PowerPlanInfo(match.Groups[1].Value, match.Groups[2].Value.Trim(), overlay);
        }
        catch (Exception e) when (e is IOException or System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            log.Write($"powercfg: {e.Message}");
        }

        return new PowerPlanInfo("", "", overlay);
    }

    [GeneratedRegex(@"GUID:\s*([0-9a-fA-F-]{36})\s*\((.*?)\)")]
    private static partial Regex SchemeLine();
}
