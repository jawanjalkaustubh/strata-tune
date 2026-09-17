using System.Runtime.InteropServices;
using StrataTune.Shared;

namespace StrataTune.Collector;

/// <summary>The unit counts NVML has no call for (docs/dependencies.md): shading units, SMs
/// and ROPs straight from the driver's nvapi64.dll, the way GPU-Z and HWiNFO read them, so
/// an RTX 50-series card that shipped with a raster engine disabled (168 ROPs on a 5090
/// instead of 176; NVIDIA confirmed the batch in February 2025) shows its real count.
/// One-shot: load from System32 only, initialise, read every GPU, unload. Anything the
/// driver refuses is null, never a guess; a missing DLL or a refused initialise is an empty
/// result, and the collector runs on without the field.</summary>
internal static class Nvapi
{
    // NVAPI has no ordinary exports: every function is fetched from nvapi_QueryInterface by a
    // 32-bit id. The ids below were verified on 2026-09-16 against three open-source readers,
    // which agree on every one: falahati/NvAPIWrapper (NvAPIWrapper/Native/Helpers/FunctionId.cs),
    // arcnmx/nvapi-rs (nvapi_sys/nvid.rs) and, for Initialize / EnumPhysicalGPUs / GetBusId,
    // LibreHardwareMonitor (LibreHardwareMonitorLib/Interop/NvApi.cs, which never unloads). Initialize,
    // Unload, EnumPhysicalGPUs, GetBusId, GetGpuCoreCount and GetArchInfo are in NVIDIA's public
    // nvapi.h (MIT, github.com/NVIDIA/nvapi); GetROPCount and GetTotalSMCount are not: nvapi-rs
    // lists the first as Unknown_GetROPCount and NvAPIWrapper as NvAPI_GPU_GetROPCount, both at
    // 0xFDC129FA, the id the GPU-Z missing-ROPs detection discussions cite, and both list
    // NvAPI_GPU_GetTotalSMCount at 0xAE5FBCFE. Measured on the dev box (driver 616.92, GB202):
    // GetGpuCoreCount 21760, GetROPCount 176, GetShaderPipeCount 11 (the GPC count),
    // GetShaderSubPipeCount 85 (the TPC count: the card has 170 SMs, two per TPC; the header's
    // "corresponds to the number of SM units" dates from when a TPC held one SM),
    // GetTotalSMCount NVAPI_NOT_SUPPORTED, GetTotalTPCCount 0. So the SM count is the direct
    // read when the driver gives it and otherwise the TPC count times the SMs per TPC the
    // architecture fixes. A driver that answers a private id with anything but NVAPI_OK
    // leaves that field null; for ROPs the audit then reports "direct read unavailable" and
    // offers the fill-rate cross-check.
    // Initialize, Unload and EnumPhysicalGPUs are the ids NvapiInterface.cs holds for both NVAPI users.
    private const uint IdGetBusId = 0x1BE0B8E5;
    private const uint IdGetGpuCoreCount = 0xC7026A87;
    private const uint IdGetShaderSubPipeCount = 0x0BE17923;
    private const uint IdGetTotalSmCount = 0xAE5FBCFE;
    private const uint IdGetRopCount = 0xFDC129FA;
    private const uint IdGetArchInfo = 0xD8265D24;

    private const int Ok = NvapiInterface.Ok;
    // NVAPI_NOT_SUPPORTED: the driver has no such count for this card (GetTotalSMCount on
    // 616.92), a missing field like NVML's NOT_SUPPORTED, not a failure worth a log line.
    private const int NotSupported = -104;
    private const string Source = "nvapi";

    // NV_GPU_ARCHITECTURE_ID (nvapi.h): the SMs per TPC and the texture units per SM are fixed
    // per architecture (one SM of eight TMUs per TPC on Maxwell and Pascal; two SMs of four
    // TMUs per TPC from Volta on), so the TPC count gives the SM and TMU counts where the
    // architecture is known, and nothing on anything older or newer than the table.
    private const uint ArchMaxwell = 0x110, ArchVolta = 0x140;
    private const uint SmsPerTpcSinceVolta = 2, SmsPerTpcMaxwellPascal = 1;
    private const uint TmusPerSmSinceVolta = 4, TmusPerSmMaxwellPascal = 8;

    [StructLayout(LayoutKind.Sequential)]
    private struct ArchInfo
    {
        public uint Version;
        public uint Architecture;
        public uint Implementation;
        public uint Revision;

        // MAKE_NVAPI_VERSION(NV_GPU_ARCH_INFO_V2, 2): sizeof | (version << 16).
        public static ArchInfo V2() => new() { Version = (uint)Marshal.SizeOf<ArchInfo>() | (2u << 16) };
    }

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate int CountFn(IntPtr gpu, out uint count);

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    private delegate int ArchInfoFn(IntPtr gpu, ref ArchInfo info);

    /// <summary>Where a refused call is reported (the collector log); the reading itself is
    /// never a failure, so nothing here throws past this class.</summary>
    public static Action<string>? Report { get; set; }

    /// <summary>Unit counts keyed by PCI bus number, the key NVML's nvmlDeviceGetPciInfo_v3
    /// shares, so each NVML device is matched to its NVAPI handle without assuming the two
    /// enumerate in the same order. Empty when NVAPI is absent or nothing could be read.</summary>
    public static IReadOnlyDictionary<uint, GpuUnits> ReadByBus()
    {
        var result = new Dictionary<uint, GpuUnits>();
        if (NvapiInterface.Unavailable is not null)
            return result;
        var initialize = Resolve<NvapiInterface.NoArgsFn>(NvapiInterface.IdInitialize);
        var unload = Resolve<NvapiInterface.NoArgsFn>(NvapiInterface.IdUnload);
        var enumerate = Resolve<NvapiInterface.EnumGpusFn>(NvapiInterface.IdEnumPhysicalGpus);
        var busId = Resolve<CountFn>(IdGetBusId);
        if (initialize is null || enumerate is null || busId is null)
        {
            Report?.Invoke("nvapi: nvapi64.dll lacks Initialize, EnumPhysicalGPUs or GetBusId; unit counts left out");
            return result;
        }
        var rc = initialize();
        if (rc != Ok)
        {
            Report?.Invoke($"nvapi: NvAPI_Initialize answered {rc}; unit counts left out");
            return result;
        }

        try
        {
            var handles = new IntPtr[NvapiInterface.MaxPhysicalGpus];
            rc = enumerate(handles, out var count);
            if (rc != Ok)
            {
                Report?.Invoke($"nvapi: NvAPI_EnumPhysicalGPUs answered {rc}; unit counts left out");
                return result;
            }
            var cores = Resolve<CountFn>(IdGetGpuCoreCount);
            var tpcs = Resolve<CountFn>(IdGetShaderSubPipeCount);
            var smCount = Resolve<CountFn>(IdGetTotalSmCount);
            var rops = Resolve<CountFn>(IdGetRopCount);
            var arch = Resolve<ArchInfoFn>(IdGetArchInfo);
            for (var i = 0; i < count; i++)
            {
                if (Count(busId, handles[i], "GetBusId") is not { } bus)
                    continue;
                var shaders = Count(cores, handles[i], "GetGpuCoreCount");
                var architecture = Architecture(arch, handles[i]);
                var sms = Count(smCount, handles[i], "GetTotalSMCount") is { } direct and > 0
                    ? direct
                    : Sms(Count(tpcs, handles[i], "GetShaderSubPipeCount"), architecture, shaders);
                result[bus] = new GpuUnits(shaders, sms, Count(rops, handles[i], "GetROPCount"), Tmus(sms, architecture), Source);
            }
        }
        finally
        {
            // Ref-counted in the driver: LibreHardwareMonitor's own NVAPI session, opened
            // later in the same process, is not disturbed by this pair.
            unload?.Invoke();
        }

        return result;
    }

    /// <summary>Null for an id this driver does not implement (an old driver, or a private
    /// id NVIDIA withdrew), which costs that field alone.</summary>
    private static T? Resolve<T>(uint id) where T : Delegate => NvapiInterface.Resolve<T>(id);

    /// <summary>A count the driver declined, or a call the driver does not offer at all, is
    /// null: the audit then says the direct read is unavailable rather than reading a zero
    /// as a card with no ROPs.</summary>
    private static uint? Count(CountFn? fn, IntPtr gpu, string name)
    {
        if (fn is null)
            return null;
        var rc = fn(gpu, out var value);
        if (rc == Ok)
            return value;
        if (rc != NotSupported)
            Report?.Invoke($"nvapi: NvAPI_GPU_{name} answered {rc}; field left out");
        return null;
    }

    private static uint? Architecture(ArchInfoFn? fn, IntPtr gpu)
    {
        if (fn is null)
            return null;
        var info = ArchInfo.V2();
        return fn(gpu, ref info) == Ok ? info.Architecture : null;
    }

    /// <summary>The SM count from the TPC count, only when the shading units divide evenly
    /// across the result: a card whose driver counts sub-pipes some other way gives no SM
    /// count rather than a wrong one.</summary>
    private static uint? Sms(uint? tpcs, uint? architecture, uint? shaders)
    {
        uint? sms = (tpcs, architecture) switch
        {
            ({ } n, >= ArchVolta) => n * SmsPerTpcSinceVolta,
            ({ } n, >= ArchMaxwell) => n * SmsPerTpcMaxwellPascal,
            _ => null,
        };
        return sms is { } count && count > 0 && shaders is { } total && total % count == 0 ? count : null;
    }

    private static uint? Tmus(uint? sms, uint? architecture) => (sms, architecture) switch
    {
        ({ } n, >= ArchVolta) => n * TmusPerSmSinceVolta,
        ({ } n, >= ArchMaxwell) => n * TmusPerSmMaxwellPascal,
        _ => null,
    };
}
