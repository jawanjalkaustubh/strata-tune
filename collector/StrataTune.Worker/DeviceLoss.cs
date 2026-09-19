using System.ComponentModel;

namespace StrataTune.Worker;

internal static class DeviceLoss
{
    // TDR never throws where the hang happened: the fence wait returns and the next call fails
    // with one of these DXGI codes (DEVICE_REMOVED, DEVICE_HUNG, DEVICE_RESET,
    // DRIVER_INTERNAL_ERROR) or ComputeSharp's own "has been lost" guard. HResult is always
    // E_FAIL on the Win32Exception, so only NativeErrorCode tells them apart.
    public static bool Matches(Exception exception) => exception switch
    {
        Win32Exception win32 => (uint)win32.NativeErrorCode is 0x887A0005 or 0x887A0006 or 0x887A0007 or 0x887A0020,
        InvalidOperationException invalid => invalid.Message.Contains("has been lost", StringComparison.Ordinal),
        _ => false,
    };
}
