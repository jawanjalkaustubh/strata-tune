namespace StrataTune.Shared;

/// <summary>Everything NVML tells us about one GPU in a single read. Units are NVML's own
/// (milliwatts, MHz, MiB) so nothing is lost before the UI decides how to show it. The
/// nullable fields are the ones NVML answers NVML_ERROR_NOT_SUPPORTED for on some cards
/// (laptop GPUs mostly) or that older drivers do not export at all: null means "this card
/// does not tell us", which is not the same number as 0.</summary>
public sealed record GpuFacts(
    int Index,
    string Name,
    string Driver,
    uint PcieCurrentGen,
    uint PcieCurrentWidth,
    uint PcieMaxGen,
    uint PcieMaxWidth,
    uint? GpuMaxPcieGen,
    ulong? Bar1TotalMiB,
    ulong VramTotalMiB,
    ulong VramUsedMiB,
    uint? PowerMilliwatts,
    uint? PowerLimitMilliwatts,
    uint SmClockMHz,
    uint MemClockMHz,
    uint TemperatureC,
    uint? GpuUtilPercent,
    uint? MemUtilPercent,
    ulong? ClocksEventReasons,
    IReadOnlyList<string> ClocksEventReasonNames);
