using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace StrataTune.Collector;

internal readonly record struct PawnIoState(bool Usable, string Detail);

/// <summary>Opens PawnIO's device the way LibreHardwareMonitor 0.9.6 does, because
/// <c>PawnIo.IsInstalled</c> does not. That property is a registry read of the uninstall
/// entry's DisplayVersion: it answers True from a non-elevated shell and says nothing about
/// whether the driver is running or whether its SYSTEM+Administrators ACL lets us in. When
/// the handle cannot be opened, LHM's <c>Execute()</c> returns a zeroed buffer and every CPU
/// and board sensor reads 0 with no exception, which is the one failure the collector must
/// never report as data.</summary>
internal static class PawnIoDevice
{
    private const string DevicePath = @"\\?\GLOBALROOT\Device\PawnIO";
    private const uint GenericRead = 0x80000000, GenericWrite = 0x40000000;
    private const uint ShareReadWrite = 0x1 | 0x2;
    private const uint OpenExisting = 3;

    [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(
        string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);

    public static PawnIoState Check()
    {
        using var handle = CreateFile(
            DevicePath, GenericRead | GenericWrite, ShareReadWrite, IntPtr.Zero, OpenExisting, 0, IntPtr.Zero);

        if (!handle.IsInvalid)
            return new PawnIoState(true, $"{DevicePath} opened");

        var error = Marshal.GetLastWin32Error();
        return new PawnIoState(false, $"{DevicePath}: {new Win32Exception(error).Message.TrimEnd('.')} ({error})");
    }
}
