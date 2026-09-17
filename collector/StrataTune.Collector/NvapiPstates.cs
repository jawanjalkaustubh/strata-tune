using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using StrataTune.Shared;

namespace StrataTune.Collector;

/// <summary>The one NVAPI surface Tune writes through: the P0 clock deltas of
/// NvAPI_GPU_GetPstates20 / SetPstates20 (plan section 16, "write path"). The first read is
/// the baseline every revert restores, but it is only what this call sees: on the dev box
/// both NVML's offsets and these deltas read 0 while the card runs memory 1979 MHz against
/// a 1750 reference (dependencies.md), so GPU Tweak III applies its OC by another route (VF
/// points), invisible here. A hunt therefore records the clocks NVML saw during its
/// reference run beside the deltas, and the export names them. The library, the shared ids
/// and the error text come from <see cref="NvapiInterface"/> (read-only NVAPI, the unit
/// counts, lives in Nvapi.cs); this file is only the pstate pair plus what it takes to
/// reach a GPU handle.
///
/// Interface ids, verified 2026-09-16 against three open sources:
///   NVIDIA/nvapi nvapi_interface.h: NvAPI_GPU_GetPstates20 0x6FF81213 (SetPstates20 is not
///     in the public table);
///   falahati/NvAPIWrapper Native/Helpers/FunctionId.cs: the same plus
///     NvAPI_GPU_SetPstates20 = 0x0F4DAE6B;
///   Demion/nvapioc Source/main.cpp: SetPstates20 0x0F4DAE6B, and the apply pattern this
///     file copies (numPstates 1, numClocks 1, pstateId P0, domainId GRAPHICS 0 / MEMORY 4,
///     typeId SINGLE 0, freqDelta_kHz.value = the offset, version = sizeof | (2 &lt;&lt; 16)).
/// Struct layout from NVIDIA/nvapi nvapi.h (NV_GPU_PERF_PSTATES20_INFO_V2): 5 header words;
/// 16 pstates of { id, flags, 8 clock entries of 44 bytes, 4 base-voltage entries of 24 };
/// then the over-volt block { count, 4 entries }: 7416 bytes, so VER2 is 0x21CF8 (nvapi.h
/// now also defines a VER3 over the same struct; VER2 is what the driver accepted live and
/// what the open tools send). Every field is a 32-bit word, and the size is asserted below
/// so a packing slip can never reach the driver.
///
/// Two rules on the write side: a delta outside the range the last read reported is
/// refused before the driver sees it, and an apply whose read-back differs from what was
/// asked is a failed apply, because the ladder must never certify a value that was not on
/// the card (a vendor tool's profile timer, a silently clamping driver, a half-applied
/// pair).</summary>
internal static class NvapiPstates
{
    private const uint IdGetPstates20 = 0x6FF81213, IdSetPstates20 = 0x0F4DAE6B;
    private const int Ok = NvapiInterface.Ok;
    private const uint PstateP0 = 0, DomainGraphics = 0, DomainMemory = 4, ClockTypeSingle = 0;
    private const int ExpectedSize = 7416;
    private const uint Version2 = ExpectedSize | (2u << 16);
    // The deltas only change when someone applies; NVML reads the facts at 10 Hz, so the
    // read side is cached and refreshed at this gap, and at once after our own apply.
    private static readonly TimeSpan CacheFor = TimeSpan.FromSeconds(2);

    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    private struct ParamDelta { public int Value, Min, Max; }

    // The union at the end (single.freq_kHz or the range block) is five words we never read.
    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    private struct ClockEntry { public uint DomainId, TypeId, Flags; public ParamDelta FreqDeltaKhz; public uint Data0, Data1, Data2, Data3, Data4; }

    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    private struct BaseVoltageEntry { public uint DomainId, Flags, VoltUv; public ParamDelta VoltDeltaUv; }

    [InlineArray(8)] private struct ClockEntries { private ClockEntry _element; }
    [InlineArray(4)] private struct BaseVoltageEntries { private BaseVoltageEntry _element; }

    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    private struct Pstate { public uint PstateId, Flags; public ClockEntries Clocks; public BaseVoltageEntries BaseVoltages; }

    [InlineArray(16)] private struct Pstates { private Pstate _element; }

    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    private struct Pstates20Info
    {
        public uint Version, Flags, NumPstates, NumClocks, NumBaseVoltages;
        public Pstates Pstates;
        public uint OvNumVoltages;
        public BaseVoltageEntries OvVoltages;
    }

    // The struct crosses as a pinned uint[] (blittable for certain) and is viewed through the
    // typed layout on this side, so no marshaller ever has an opinion about InlineArray.
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] private delegate int Pstates20Fn(IntPtr gpu, [In, Out] uint[] info);

    private static readonly Lock Gate = new();
    private static bool _resolved;
    private static string? _unavailable;
    private static Pstates20Fn? _get, _set;
    private static IntPtr _gpu;
    private static int _gpuCount;
    private static PstateDeltaRange? _cached;
    private static DateTimeOffset _cachedAt = DateTimeOffset.MinValue;

    /// <summary>How many physical GPUs NvAPI_EnumPhysicalGPUs listed; 0 until resolved.
    /// Tune writes to handle 0 only, so a hunt refuses to start on a box with more.</summary>
    public static int GpuCount
    {
        get { lock (Gate) return _gpuCount; }
    }

    /// <summary>Why the write path is unavailable (no nvapi64.dll, no NVIDIA GPU, a driver
    /// that answers NOT_SUPPORTED), or null when it works; null before the first call.</summary>
    public static string? Unavailable
    {
        get { lock (Gate) return _unavailable; }
    }

    /// <summary>The P0 core and memory deltas with the driver's allowed range, or null with
    /// the reason. Never throws: a box without the DLL is a null here, not a failed collector.</summary>
    public static PstateDeltaRange? ReadDeltas(out string? failure)
    {
        lock (Gate)
        {
            if (!Resolve(out failure))
                return null;
            var buffer = Fresh();
            var rc = _get!(_gpu, buffer);
            if (rc != Ok)
            {
                failure = $"NvAPI_GPU_GetPstates20: {Describe(rc)}";
                return null;
            }
            ref var info = ref View(buffer);
            ClockEntry? core = null, mem = null;
            for (var p = 0; p < Math.Min(info.NumPstates, 16u); p++)
            {
                ref var pstate = ref info.Pstates[p];
                if (pstate.PstateId != PstateP0)
                    continue;
                for (var c = 0; c < Math.Min(info.NumClocks, 8u); c++)
                {
                    var entry = pstate.Clocks[c];
                    if (entry.DomainId == DomainGraphics)
                        core = entry;
                    else if (entry.DomainId == DomainMemory)
                        mem = entry;
                }
            }
            if (core is not { } g || mem is not { } m)
            {
                failure = "NvAPI_GPU_GetPstates20: P0 has no graphics or memory clock entry";
                return null;
            }
            var read = new PstateDeltaRange(
                new TuneDeltas(g.FreqDeltaKhz.Value, m.FreqDeltaKhz.Value),
                g.FreqDeltaKhz.Min, g.FreqDeltaKhz.Max, m.FreqDeltaKhz.Min, m.FreqDeltaKhz.Max,
                (g.Flags & 1) != 0 && (m.Flags & 1) != 0);
            _cached = read;
            _cachedAt = DateTimeOffset.UtcNow;
            failure = null;
            return read;
        }
    }

    /// <summary>The read side for the 10 Hz GPU facts: the last read, refreshed at most every
    /// two seconds so the sampler never pays for a driver round trip it does not need.</summary>
    public static PstateDeltas? Cached()
    {
        lock (Gate)
        {
            if (DateTimeOffset.UtcNow - _cachedAt > CacheFor)
                ReadDeltas(out _);
            return _cached is { } r ? new PstateDeltas(r.Deltas.CoreKhz / 1000, r.Deltas.MemKhz / 1000) : null;
        }
    }

    /// <summary>Applies both P0 deltas, core then memory, one SetPstates20 call each (the
    /// pattern every open OC tool uses). False with the NVAPI status on the first failure;
    /// a failure after the core call leaves the card half-applied, which is why the caller
    /// re-applies its baseline on any false. The read-back must equal the request or the
    /// apply is false too; the cache is refreshed from it so the facts show what the driver
    /// holds, not what we asked for.</summary>
    public static bool ApplyDeltas(TuneDeltas deltas, out string status)
    {
        lock (Gate)
        {
            if (!Resolve(out var failure))
            {
                status = failure!;
                return false;
            }
            var range = _cached ?? ReadDeltas(out failure);
            if (range is null)
            {
                status = $"the driver's delta range is unknown: {failure}";
                return false;
            }
            if (deltas.CoreKhz < range.CoreMinKhz || deltas.CoreKhz > range.CoreMaxKhz || deltas.MemKhz < range.MemMinKhz || deltas.MemKhz > range.MemMaxKhz)
            {
                status = $"refused: core {deltas.CoreKhz} / memory {deltas.MemKhz} kHz is outside the driver's range (core {range.CoreMinKhz}..{range.CoreMaxKhz}, memory {range.MemMinKhz}..{range.MemMaxKhz})";
                return false;
            }
            foreach (var (domain, khz, name) in new[] { (DomainGraphics, deltas.CoreKhz, "core"), (DomainMemory, deltas.MemKhz, "memory") })
            {
                var buffer = Fresh();
                ref var info = ref View(buffer);
                info.NumPstates = 1;
                info.NumClocks = 1;
                info.Pstates[0].PstateId = PstateP0;
                info.Pstates[0].Clocks[0].DomainId = domain;
                info.Pstates[0].Clocks[0].TypeId = ClockTypeSingle;
                info.Pstates[0].Clocks[0].FreqDeltaKhz.Value = khz;
                var rc = _set!(_gpu, buffer);
                if (rc != Ok)
                {
                    status = $"NvAPI_GPU_SetPstates20({name} {khz} kHz): {Describe(rc)}";
                    _cachedAt = DateTimeOffset.MinValue;
                    return false;
                }
            }
            var back = ReadDeltas(out var readFailure);
            if (back is null)
            {
                status = $"applied core {deltas.CoreKhz} / memory {deltas.MemKhz} kHz but the read-back failed: {readFailure}";
                return false;
            }
            if (back.Deltas != deltas)
            {
                status = $"asked for core {deltas.CoreKhz} / memory {deltas.MemKhz} kHz but the driver holds {back.Deltas.CoreKhz} / {back.Deltas.MemKhz}: the apply did not take";
                return false;
            }
            status = $"applied core {deltas.CoreKhz} / memory {deltas.MemKhz} kHz; driver reads back the same";
            return true;
        }
    }

    private static bool Resolve(out string? failure)
    {
        if (_resolved)
        {
            failure = _unavailable;
            return _unavailable is null;
        }
        _resolved = true;
        _unavailable = TryResolve();
        failure = _unavailable;
        return _unavailable is null;
    }

    private static string? TryResolve()
    {
        if (Unsafe.SizeOf<Pstates20Info>() != ExpectedSize)
            return $"NV_GPU_PERF_PSTATES20_INFO_V2 is laid out as {Unsafe.SizeOf<Pstates20Info>()} bytes, expected {ExpectedSize}; refusing to call the driver";
        if (NvapiInterface.Unavailable is { } unavailable)
            return unavailable;
        if (NvapiInterface.Resolve<NvapiInterface.NoArgsFn>(NvapiInterface.IdInitialize) is not { } initialize)
            return "NvAPI_Initialize not exported";
        var rc = initialize();
        if (rc != Ok)
            return $"NvAPI_Initialize: {Describe(rc)}";
        if (NvapiInterface.Resolve<NvapiInterface.EnumGpusFn>(NvapiInterface.IdEnumPhysicalGpus) is not { } enumerate)
            return "NvAPI_EnumPhysicalGPUs not exported";
        var handles = new IntPtr[NvapiInterface.MaxPhysicalGpus];
        rc = enumerate(handles, out var count);
        if (rc != Ok)
            return $"NvAPI_EnumPhysicalGPUs: {Describe(rc)}";
        if (count == 0)
            return "NvAPI_EnumPhysicalGPUs: no NVIDIA GPU";
        // The first physical GPU, which is the NVML index 0 card on every single-card box;
        // the supervisor refuses a hunt when there is more than one, until the handle is
        // matched to the worker's adapter by PCI bus id (Nvapi.cs does that for unit counts).
        _gpuCount = (int)count;
        _gpu = handles[0];
        _get = NvapiInterface.Resolve<Pstates20Fn>(IdGetPstates20);
        _set = NvapiInterface.Resolve<Pstates20Fn>(IdSetPstates20);
        if (_get is null || _set is null)
            return "this driver does not export NvAPI_GPU_GetPstates20 / SetPstates20";
        return null;
    }

    private static uint[] Fresh()
    {
        var buffer = new uint[ExpectedSize / sizeof(uint)];
        buffer[0] = Version2;
        return buffer;
    }

    private static ref Pstates20Info View(uint[] buffer) =>
        ref MemoryMarshal.AsRef<Pstates20Info>(MemoryMarshal.AsBytes(buffer.AsSpan()));

    private static string Describe(int rc) => NvapiInterface.Describe(rc);
}
