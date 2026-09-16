namespace StrataTune.Shared;

/// <summary>Everything NVML tells us about one GPU in a single read, in NVML's own units
/// (milliwatts, MHz, MiB). The one GPU shape: the snapshot's gpus[] is the state at capture
/// time and the live stream carries the changing fields. A field this card answers
/// NOT_SUPPORTED for reads 0, because the wire contract has no null there.</summary>
public sealed record GpuFacts(
    int Index,
    string Name,
    string Driver,
    GpuPcie Pcie,
    ulong Bar1TotalMiB,
    GpuVram Vram,
    uint PowerMw,
    uint PowerLimitMw,
    uint PowerMaxLimitMw,
    GpuClocks Clocks,
    uint TemperatureC,
    GpuUtilisation Utilisation,
    ClocksEventReasons ClocksEventReasons);

public sealed record GpuPcie(uint CurrentGen, uint CurrentWidth, uint MaxGen, uint MaxWidth, uint GpuMaxGen);

public sealed record GpuVram(ulong TotalMiB, ulong UsedMiB);

public sealed record GpuClocks(uint SmMhz, uint MemMhz);

public sealed record GpuUtilisation(uint Gpu, uint Memory);

/// <summary>The raw NVML bitmask plus the decoded known bits; bits newer than the public
/// header stay in <see cref="Raw"/> and appear as "Unknown(0x…)" in <see cref="Names"/>.</summary>
public sealed record ClocksEventReasons(ulong Raw, IReadOnlyList<string> Names);
