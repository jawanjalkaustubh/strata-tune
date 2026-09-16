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
    ClocksEventReasons ClocksEventReasons,
    GpuPciSubsystem? PciSubsystem,
    GpuClockOffsets? ClockOffsets);

public sealed record GpuPcie(uint CurrentGen, uint CurrentWidth, uint MaxGen, uint MaxWidth, uint GpuMaxGen);

public sealed record GpuVram(ulong TotalMiB, ulong UsedMiB);

public sealed record GpuClocks(uint SmMhz, uint MemMhz);

public sealed record GpuUtilisation(uint Gpu, uint Memory);

/// <summary>The raw NVML bitmask plus the decoded known bits; bits newer than the public
/// header stay in <see cref="Raw"/> and appear as "Unknown(0x…)" in <see cref="Names"/>.</summary>
public sealed record ClocksEventReasons(ulong Raw, IReadOnlyList<string> Names);

/// <summary>The board's subsystem ids: the vendor id names the board partner (ASUS, MSI, …),
/// which nvmlDeviceGetName never says.</summary>
public sealed record GpuPciSubsystem(uint VendorId, uint DeviceId);

/// <summary>Applied overclock offsets at P0 (nvmlDeviceGetClockOffsets, NVML 12.5+) and the
/// driver's clock-table ceilings for the SM and memory clocks (nvmlDeviceGetMaxClockInfo:
/// 3090 / 14001 MHz on the dev box's RTX 5090, which is not the board's rated boost). A card
/// held above a ceiling under load is overclocked by a route the offsets do not report. Null
/// for a field the card does not answer; the whole record is null when the driver lacks the
/// offsets export.</summary>
public sealed record GpuClockOffsets(int? SmMhz, int? MemMhz, uint? MaxClockSmMhz, uint? MaxClockMemMhz);
