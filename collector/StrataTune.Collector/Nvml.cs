using System.Runtime.InteropServices;
using System.Text;
using StrataTune.Shared;

namespace StrataTune.Collector;

// The prototypes and structs in this file are transcribed from NVIDIA's nvml.h. Its notice
// grants a royalty-free licence to use that code and asks that the disclaimer and the U.S.
// Government End Users notice be reproduced alongside; they are:
//
//   Copyright 1993-2024 NVIDIA Corporation.  All rights reserved.
//
//   NVIDIA MAKES NO REPRESENTATION ABOUT THE SUITABILITY OF THIS SOURCE CODE FOR ANY
//   PURPOSE.  IT IS PROVIDED "AS IS" WITHOUT EXPRESS OR IMPLIED WARRANTY OF ANY KIND.
//   NVIDIA DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOURCE CODE, INCLUDING ALL IMPLIED
//   WARRANTIES OF MERCHANTABILITY, NONINFRINGEMENT, AND FITNESS FOR A PARTICULAR PURPOSE.
//   IN NO EVENT SHALL NVIDIA BE LIABLE FOR ANY SPECIAL, INDIRECT, INCIDENTAL, OR
//   CONSEQUENTIAL DAMAGES, OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR
//   PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
//   ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOURCE CODE.
//
//   U.S. Government End Users.  This source code is a "commercial item" as that term is
//   defined at 48 C.F.R. 2.101 (OCT 1995), consisting of "commercial computer software" and
//   "commercial computer software documentation" as such terms are used in 48 C.F.R. 12.212
//   (SEPT 1995) and is provided to the U.S. Government only as a commercial end item.
//   Consistent with 48 C.F.R. 12.212 and 48 C.F.R. 227.7202-1 through 227.7202-4 (JUNE 1995),
//   all U.S. Government End Users acquire the source code with only those rights set forth
//   herein.

/// <summary>Reads GPU facts straight from the driver's nvml.dll. No NuGet wrapper is current
/// enough to trust (docs/dependencies.md), so the handful of calls we need are declared here.
/// <see cref="Open"/> keeps NVML initialised for a long-running sampler; <see cref="Read"/>
/// is the one-shot form the probe uses.</summary>
internal static class Nvml
{
    private const string Lib = "nvml";
    private const int Success = 0;
    // NVML_ERROR_NOT_SUPPORTED: this card does not have the field, which is not a failure.
    private const int NotSupported = 3;
    // NVML_ERROR_INVALID_ARGUMENT: what the clock-offset call answers for a clock type the card has no offset for.
    private const int InvalidArgument = 2;
    private const uint ClockGraphics = 0, ClockSm = 1, ClockMem = 2, TemperatureGpu = 0;
    private const uint PstateP0 = 0;
    private const ulong MiB = 1024 * 1024;

    // Public header bits; anything above 0x100 is newer than the header and printed as hex.
    private static readonly (ulong Bit, string Name)[] ReasonBits =
    [
        (0x1, "GpuIdle"), (0x2, "ApplicationsClocksSetting"), (0x4, "SwPowerCap"),
        (0x8, "HwSlowdown"), (0x10, "SyncBoost"), (0x20, "SwThermalSlowdown"),
        (0x40, "HwThermalSlowdown"), (0x80, "HwPowerBrakeSlowdown"), (0x100, "DisplayClockSetting"),
    ];

    [StructLayout(LayoutKind.Sequential)]
    private struct Bar1Memory { public ulong Total, Free, Used; }

    [StructLayout(LayoutKind.Sequential)]
    private struct Memory { public ulong Total, Free, Used; }

    [StructLayout(LayoutKind.Sequential)]
    private struct Utilization { public uint Gpu, Memory; }

    // nvmlPciInfo_t: busIdLegacy[16], domain, bus, device, pciDeviceId, pciSubSystemId,
    // busId[32]. Only the two ids are read, so the char arrays are left as padding and the
    // struct stays blittable.
    [StructLayout(LayoutKind.Explicit, Size = 68)]
    private struct PciInfo
    {
        [FieldOffset(28)] public uint PciDeviceId;
        [FieldOffset(32)] public uint PciSubSystemId;
    }

    // nvmlClockOffset_v1_t, versioned the NVML way: (1 << 24) | sizeof. The caller fills
    // version, type and pstate; the driver fills the three offsets.
    [StructLayout(LayoutKind.Sequential)]
    internal struct ClockOffset
    {
        public uint Version;
        public uint Type;
        public uint Pstate;
        public int ClockOffsetMHz;
        public int MinClockOffsetMHz;
        public int MaxClockOffsetMHz;

        public static ClockOffset For(uint type) => new() { Version = (1u << 24) | (uint)Marshal.SizeOf<ClockOffset>(), Type = type, Pstate = PstateP0 };
    }

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    internal delegate int ReasonsFn(IntPtr device, out ulong reasons);

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
    internal delegate int ClockOffsetsFn(IntPtr device, ref ClockOffset info);

    private delegate int Query<T>(IntPtr device, out T value) where T : struct;

    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] private static extern int nvmlInit_v2();
    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] private static extern int nvmlShutdown();
    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] private static extern IntPtr nvmlErrorString(int result);
    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] private static extern int nvmlSystemGetDriverVersion(byte[] version, uint length);
    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] private static extern int nvmlDeviceGetCount_v2(out uint count);
    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] private static extern int nvmlDeviceGetHandleByIndex_v2(uint index, out IntPtr device);
    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] private static extern int nvmlDeviceGetName(IntPtr device, byte[] name, uint length);
    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] private static extern int nvmlDeviceGetCurrPcieLinkGeneration(IntPtr device, out uint gen);
    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] private static extern int nvmlDeviceGetCurrPcieLinkWidth(IntPtr device, out uint width);
    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] private static extern int nvmlDeviceGetMaxPcieLinkGeneration(IntPtr device, out uint gen);
    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] private static extern int nvmlDeviceGetMaxPcieLinkWidth(IntPtr device, out uint width);
    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] private static extern int nvmlDeviceGetGpuMaxPcieLinkGeneration(IntPtr device, out uint gen);
    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] private static extern int nvmlDeviceGetBAR1MemoryInfo(IntPtr device, out Bar1Memory bar1);
    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] private static extern int nvmlDeviceGetPowerUsage(IntPtr device, out uint milliwatts);
    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] private static extern int nvmlDeviceGetPowerManagementLimit(IntPtr device, out uint milliwatts);
    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] private static extern int nvmlDeviceGetPowerManagementLimitConstraints(IntPtr device, out uint minMilliwatts, out uint maxMilliwatts);
    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] private static extern int nvmlDeviceGetClockInfo(IntPtr device, uint type, out uint mhz);
    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] private static extern int nvmlDeviceGetTemperature(IntPtr device, uint sensor, out uint celsius);
    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] private static extern int nvmlDeviceGetMemoryInfo(IntPtr device, out Memory memory);
    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] private static extern int nvmlDeviceGetUtilizationRates(IntPtr device, out Utilization utilization);
    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] private static extern int nvmlDeviceGetPciInfo_v3(IntPtr device, out PciInfo pci);
    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)] private static extern int nvmlDeviceGetMaxClockInfo(IntPtr device, uint type, out uint mhz);

    private static IntPtr _handle;

    static Nvml()
    {
        NativeLibrary.SetDllImportResolver(typeof(Nvml).Assembly, (name, _, _) =>
            name == Lib ? Handle() : IntPtr.Zero);
    }

    /// <summary>Loads the driver's own copy from System32, once per process. Returning
    /// IntPtr.Zero from the resolver instead would hand the bare name to the default search
    /// order, which starts with the exe's own directory.</summary>
    private static IntPtr Handle()
    {
        if (_handle == IntPtr.Zero)
        {
            var path = Path.Combine(Environment.SystemDirectory, "nvml.dll");
            if (!NativeLibrary.TryLoad(path, out _handle))
                throw new DllNotFoundException($"{path} not found — no NVIDIA driver on this machine");
        }

        return _handle;
    }

    /// <summary>Init, read every GPU, shutdown. Throws naming the NVML call that failed.</summary>
    public static IReadOnlyList<GpuFacts> Read()
    {
        using var session = Open();
        return session.Read();
    }

    /// <summary>Initialises NVML and keeps it initialised until disposed, for a sampler that
    /// reads ten times a second. Reads are serialised on the session.</summary>
    public static Session Open()
    {
        Handle();
        Check(nvmlInit_v2(), nameof(nvmlInit_v2));
        try
        {
            var driver = new byte[80];
            Check(nvmlSystemGetDriverVersion(driver, (uint)driver.Length), nameof(nvmlSystemGetDriverVersion));
            Check(nvmlDeviceGetCount_v2(out var count), nameof(nvmlDeviceGetCount_v2));
            return new Session(AsciiZ(driver), count, ResolveReasons(), ResolveClockOffsets());
        }
        catch
        {
            nvmlShutdown();
            throw;
        }
    }

    internal sealed class Session(string driver, uint count, ReasonsFn? reasons, ClockOffsetsFn? clockOffsets) : IDisposable
    {
        private readonly Lock _gate = new();

        public string Driver { get; } = driver;

        /// <summary>One GPU that fails a mandatory call (a driver reset in progress, a mobile
        /// part answering NOT_SUPPORTED) is skipped, so a second card never blanks the first.
        /// Only when no card could be read at all does the failure surface.</summary>
        public IReadOnlyList<GpuFacts> Read()
        {
            lock (_gate)
            {
                var list = new List<GpuFacts>((int)count);
                InvalidOperationException? failure = null;
                for (uint i = 0; i < count; i++)
                {
                    try
                    {
                        list.Add(ReadOne(i, Driver, reasons, clockOffsets));
                    }
                    catch (InvalidOperationException e)
                    {
                        failure = new InvalidOperationException($"GPU {i}: {e.Message}", e);
                    }
                }
                if (list.Count == 0 && failure is not null)
                    throw failure;
                return list;
            }
        }

        public void Dispose()
        {
            // The library stays loaded: the DllImport stubs cache its function pointers, so
            // freeing it would leave them dangling for a later Open().
            lock (_gate)
                nvmlShutdown();
        }
    }

    // 616.92 exports the renamed call; older drivers only the Throttle spelling (same
    // bitmask), and a driver with neither loses the bitmask, not the rest of the card.
    private static ReasonsFn? ResolveReasons()
    {
        string[] spellings = ["nvmlDeviceGetCurrentClocksEventReasons", "nvmlDeviceGetCurrentClocksThrottleReasons"];
        foreach (var name in spellings)
            if (NativeLibrary.TryGetExport(_handle, name, out var fn))
                return Marshal.GetDelegateForFunctionPointer<ReasonsFn>(fn);

        return null;
    }

    // nvmlDeviceGetClockOffsets arrived with NVML 12.5; an older driver simply has no
    // overclock report, and the audit says so rather than reading zero offsets.
    private static ClockOffsetsFn? ResolveClockOffsets() =>
        NativeLibrary.TryGetExport(_handle, "nvmlDeviceGetClockOffsets", out var fn)
            ? Marshal.GetDelegateForFunctionPointer<ClockOffsetsFn>(fn)
            : null;

    private static GpuFacts ReadOne(uint index, string driver, ReasonsFn? reasons, ClockOffsetsFn? clockOffsets)
    {
        Check(nvmlDeviceGetHandleByIndex_v2(index, out var dev), nameof(nvmlDeviceGetHandleByIndex_v2));
        var name = new byte[96];
        Check(nvmlDeviceGetName(dev, name, (uint)name.Length), nameof(nvmlDeviceGetName));
        Check(nvmlDeviceGetCurrPcieLinkGeneration(dev, out var curGen), nameof(nvmlDeviceGetCurrPcieLinkGeneration));
        Check(nvmlDeviceGetCurrPcieLinkWidth(dev, out var curWidth), nameof(nvmlDeviceGetCurrPcieLinkWidth));
        Check(nvmlDeviceGetMaxPcieLinkGeneration(dev, out var maxGen), nameof(nvmlDeviceGetMaxPcieLinkGeneration));
        Check(nvmlDeviceGetMaxPcieLinkWidth(dev, out var maxWidth), nameof(nvmlDeviceGetMaxPcieLinkWidth));
        Check(nvmlDeviceGetMemoryInfo(dev, out var mem), nameof(nvmlDeviceGetMemoryInfo));
        Check(nvmlDeviceGetClockInfo(dev, ClockSm, out var sm), nameof(nvmlDeviceGetClockInfo) + "(SM)");
        Check(nvmlDeviceGetClockInfo(dev, ClockMem, out var memClock), nameof(nvmlDeviceGetClockInfo) + "(MEM)");
        Check(nvmlDeviceGetTemperature(dev, TemperatureGpu, out var temp), nameof(nvmlDeviceGetTemperature));

        // The rest are optional: BAR1, the power limits and the utilisation rates answer
        // NOT_SUPPORTED on several laptop and older cards, and
        // nvmlDeviceGetGpuMaxPcieLinkGeneration only exists on newer drivers. Losing one of
        // them must not cost us the name, clocks and temperature that did read; the wire
        // shape has no null, so an absent field is 0.
        var gpuMaxGen = Optional<uint>(nvmlDeviceGetGpuMaxPcieLinkGeneration, dev) ?? 0;
        var bar1 = Optional<Bar1Memory>(nvmlDeviceGetBAR1MemoryInfo, dev);
        var power = Optional<uint>(nvmlDeviceGetPowerUsage, dev) ?? 0;
        var limit = Optional<uint>(nvmlDeviceGetPowerManagementLimit, dev) ?? 0;
        var maxLimit = OptionalMaxLimit(dev);
        var util = Optional<Utilization>(nvmlDeviceGetUtilizationRates, dev);
        var bits = reasons is null ? null : Optional<ulong>(reasons.Invoke, dev, "clocks event reasons");
        var pci = Optional<PciInfo>(nvmlDeviceGetPciInfo_v3, dev);

        return new GpuFacts(
            (int)index, AsciiZ(name), driver,
            new GpuPcie(curGen, curWidth, maxGen, maxWidth, gpuMaxGen),
            (bar1?.Total ?? 0) / MiB,
            new GpuVram(mem.Total / MiB, mem.Used / MiB),
            power, limit, maxLimit,
            new GpuClocks(sm, memClock),
            temp,
            new GpuUtilisation(util?.Gpu ?? 0, util?.Memory ?? 0),
            new ClocksEventReasons(bits ?? 0, DecodeReasons(bits ?? 0)),
            // pciSubSystemId packs the subsystem device id in the high half and the vendor id in the low half.
            pci is { } p ? new GpuPciSubsystem(p.PciSubSystemId & 0xFFFF, p.PciSubSystemId >> 16) : null,
            clockOffsets is null ? null : ReadClockOffsets(clockOffsets, dev));
    }

    /// <summary>Where an offsets call that answers something other than success, INVALID_ARGUMENT
    /// or NOT_SUPPORTED is reported, once per process: the field is optional, so the code is a
    /// log line, never a lost card.</summary>
    public static Action<string>? ReportOffsetsFailure { get; set; }
    private static int _offsetsFailureReported;

    /// <summary>The P0 offsets for the core and memory clocks. The core offset lives under
    /// the GRAPHICS type (measured on the RTX 5090 with driver 616.92: GRAPHICS answers with
    /// a −1000…+1000 range, SM answers INVALID_ARGUMENT), the same field nvidia-settings calls
    /// GPUGraphicsClockOffset; SM is tried second for a driver that files it there instead.
    /// A clock type the card has no offset for answers INVALID_ARGUMENT or NOT_SUPPORTED;
    /// any other code (a driver that moved the struct to v2, NO_PERMISSION) is null for the
    /// field too, because an optional field never costs the mandatory ones.</summary>
    private static GpuClockOffsets ReadClockOffsets(ClockOffsetsFn fn, IntPtr dev)
    {
        int? Offset(uint type)
        {
            var info = ClockOffset.For(type);
            var rc = fn(dev, ref info);
            if (rc == Success)
                return info.ClockOffsetMHz;
            if (rc is not (InvalidArgument or NotSupported) && Interlocked.Exchange(ref _offsetsFailureReported, 1) == 0)
                ReportOffsetsFailure?.Invoke($"nvml: clock offsets unreadable, left out: {Failure(rc, "nvmlDeviceGetClockOffsets").Message}");
            return null;
        }

        uint? MaxClock(uint type, string name) =>
            Optional<uint>((IntPtr d, out uint mhz) => nvmlDeviceGetMaxClockInfo(d, type, out mhz), dev, $"nvmlDeviceGetMaxClockInfo({name})");

        var sm = Offset(ClockGraphics) ?? Offset(ClockSm);
        var mem = Offset(ClockMem);
        return new GpuClockOffsets(sm, mem, MaxClock(ClockSm, "SM"), MaxClock(ClockMem, "MEM"));
    }

    private static uint OptionalMaxLimit(IntPtr dev)
    {
        try
        {
            var rc = nvmlDeviceGetPowerManagementLimitConstraints(dev, out _, out var max);
            return rc switch
            {
                Success => max,
                NotSupported => 0,
                _ => throw Failure(rc, nameof(nvmlDeviceGetPowerManagementLimitConstraints)),
            };
        }
        catch (EntryPointNotFoundException)
        {
            return 0;
        }
    }

    /// <summary>A call whose absence is a missing field rather than a failed read:
    /// NOT_SUPPORTED and an export the driver never had both come back null.</summary>
    private static T? Optional<T>(Query<T> query, IntPtr device, string? call = null) where T : struct
    {
        try
        {
            var rc = query(device, out var value);
            return rc switch
            {
                Success => value,
                NotSupported => null,
                _ => throw Failure(rc, call ?? query.Method.Name),
            };
        }
        catch (EntryPointNotFoundException)
        {
            return null;
        }
    }

    internal static IReadOnlyList<string> DecodeReasons(ulong mask)
    {
        if (mask == 0)
            return ["None"];
        var names = new List<string>();
        ulong known = 0;
        foreach (var (bit, name) in ReasonBits)
        {
            known |= bit;
            if ((mask & bit) != 0)
                names.Add(name);
        }
        var unknown = mask & ~known;
        if (unknown != 0)
            names.Add($"Unknown(0x{unknown:X})");
        return names;
    }

    private static void Check(int rc, string call)
    {
        if (rc != Success)
            throw Failure(rc, call);
    }

    private static InvalidOperationException Failure(int rc, string call) =>
        new($"{call}: {Marshal.PtrToStringAnsi(nvmlErrorString(rc))} ({rc})");

    private static string AsciiZ(byte[] buffer)
    {
        var end = Array.IndexOf(buffer, (byte)0);
        return Encoding.ASCII.GetString(buffer, 0, end < 0 ? buffer.Length : end);
    }
}
