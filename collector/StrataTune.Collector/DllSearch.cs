using System.ComponentModel;
using System.Runtime.InteropServices;

namespace StrataTune.Collector;

/// <summary>Narrows native DLL loading to System32 and the exe's own directory, before any
/// library is touched. LibreHardwareMonitorLib loads nvapi64.dll, atiadlxx.dll, nvml.dll,
/// Ftd2xx.dll and ControlLib.dll by bare name, which by default searches the current
/// directory and %PATH% as well; in an elevated process that is a way for a standard user to
/// get code running as administrator. Pair it with the install-location rule in
/// collector/README.md: this exe only ever lives somewhere a standard user cannot write.</summary>
internal static class DllSearch
{
    private const uint SearchApplicationDir = 0x200, SearchSystem32 = 0x800;

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetDefaultDllDirectories(uint directoryFlags);

    public static void RestrictToSystem32AndAppDirectory()
    {
        if (!SetDefaultDllDirectories(SearchSystem32 | SearchApplicationDir))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "SetDefaultDllDirectories failed");
    }
}
