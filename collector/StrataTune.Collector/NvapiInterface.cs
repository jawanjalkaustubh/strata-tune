using System.Runtime.InteropServices;
using System.Text;

namespace StrataTune.Collector;

/// <summary>The one way into nvapi64.dll for its two users, <see cref="Nvapi"/> (unit counts,
/// read-only) and <see cref="NvapiPstates"/> (the P0 clock deltas, the write path): the
/// driver's own copy from System32 by full path, never a bare name (an elevated process must
/// not find an nvapi64.dll beside its exe or on %PATH%), loaded once per process, and its
/// single true export nvapi_QueryInterface, from which every function is fetched by a 32-bit
/// id. The ids both users need are here so the table exists once; each keeps the ids only
/// it calls. NVAPI is ref-counted in the driver, so the unit-count read's Initialize / Unload
/// pair does not disturb the pstate session opened later in the same process.</summary>
internal static class NvapiInterface
{
    // Verified 2026-09-16 against NVIDIA/nvapi nvapi_interface.h (MIT) and the open-source
    // readers named in Nvapi.cs, which agree on every one.
    public const uint IdInitialize = 0x0150E828;
    public const uint IdUnload = 0xD22BDD7E;
    public const uint IdEnumPhysicalGpus = 0xE5AC921F;
    public const uint IdGetErrorMessage = 0x6C2D048C;

    public const int Ok = 0;
    /// <summary>NVAPI_MAX_PHYSICAL_GPUS in nvapi_lite_common.h: the handle array EnumPhysicalGPUs fills.</summary>
    public const int MaxPhysicalGpus = 64;

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] public delegate int NoArgsFn();
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] public delegate int EnumGpusFn([Out] IntPtr[] handles, out uint count);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate IntPtr QueryInterfaceFn(uint id);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int GetErrorMessageFn(int status, byte[] message);

    private static readonly string LibraryPath = Path.Combine(Environment.SystemDirectory, "nvapi64.dll");
    private static readonly Lock Gate = new();
    private static bool _tried;
    private static string? _unavailable;
    private static QueryInterfaceFn? _query;
    private static GetErrorMessageFn? _errorMessage;

    /// <summary>Why the library cannot be used (no NVIDIA driver, or a DLL without the export), or null when it can; tried once per process.</summary>
    public static string? Unavailable
    {
        get
        {
            lock (Gate)
            {
                if (_tried)
                    return _unavailable;
                _tried = true;
                if (!NativeLibrary.TryLoad(LibraryPath, out var lib))
                    _unavailable = $"{LibraryPath} not found: no NVIDIA driver";
                else if (!NativeLibrary.TryGetExport(lib, "nvapi_QueryInterface", out var export))
                    _unavailable = "nvapi64.dll has no nvapi_QueryInterface export";
                else
                {
                    _query = Marshal.GetDelegateForFunctionPointer<QueryInterfaceFn>(export);
                    var fn = _query(IdGetErrorMessage);
                    _errorMessage = fn == IntPtr.Zero ? null : Marshal.GetDelegateForFunctionPointer<GetErrorMessageFn>(fn);
                }
                return _unavailable;
            }
        }
    }

    /// <summary>The function behind an id, or null for one this driver does not implement (an
    /// old driver, or a private id NVIDIA withdrew), which costs that call alone.</summary>
    public static T? Resolve<T>(uint id) where T : Delegate
    {
        if (Unavailable is not null)
            return null;
        var fn = _query!(id);
        return fn == IntPtr.Zero ? null : Marshal.GetDelegateForFunctionPointer<T>(fn);
    }

    /// <summary>The driver's own words for a status (NvAPI_GetErrorMessage) with the number, or the number alone.</summary>
    public static string Describe(int rc)
    {
        if (Unavailable is null && _errorMessage is not null)
        {
            var text = new byte[64];
            if (_errorMessage(rc, text) == Ok)
            {
                var end = Array.IndexOf(text, (byte)0);
                var message = Encoding.ASCII.GetString(text, 0, end < 0 ? text.Length : end);
                if (message.Length > 0)
                    return $"{message} ({rc})";
            }
        }
        return $"NvAPI status {rc}";
    }
}
