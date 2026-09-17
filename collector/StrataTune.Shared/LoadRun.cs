using System.Text.Json.Serialization;

namespace StrataTune.Shared;

public enum LoadKind
{
    [JsonStringEnumMemberName("light")] Light,
    [JsonStringEnumMemberName("heavy")] Heavy,
    /// <summary>The all-logical-CPU vector FMA (logistic map) kernel; the GPU is left alone.</summary>
    [JsonStringEnumMemberName("cpu")] Cpu,
    /// <summary>The bench's --fillrate mode instead of the worker: full-screen quads as fast as
    /// the card writes pixels, GPU sampled like the worker kinds so the pixel rate has its clock.</summary>
    [JsonStringEnumMemberName("fillrate")] FillRate,
}

public enum LoadRunState
{
    [JsonStringEnumMemberName("running")] Running,
    [JsonStringEnumMemberName("done")] Done,
    [JsonStringEnumMemberName("failed")] Failed,
    /// <summary>Stopped through POST /load/{id}/cancel (plan section 17c): the process was killed, the samples taken until then are kept, and no error is recorded.</summary>
    [JsonStringEnumMemberName("cancelled")] Cancelled,
}

public sealed record LoadRunRequest(LoadKind Kind, int Seconds);

/// <summary>One worker run under the collector's watch. <see cref="ExitCode"/> uses the
/// worker's mapping: 0 ok, 3 no hardware GPU, 10 device lost.</summary>
public sealed record LoadRun(
    string Id,
    LoadKind Kind,
    int Seconds,
    LoadRunState State,
    int? ExitCode,
    long QpcStart,
    long? QpcEnd,
    IReadOnlyList<GpuSample> GpuSamples,
    IReadOnlyList<CpuSample> CpuSamples,
    FillRateResult? FillRate,
    string? Error);

/// <summary>The bench's one --fillrate --json line, as printed: pixels per wall second over
/// <see cref="Seconds"/> of measurement (the warm-up is not counted), the frames that made
/// them and the offscreen target they were drawn into. Null for every other kind.</summary>
public sealed record FillRateResult(double PixelsPerSecond, double Seconds, int Frames, int Width, int Height);

/// <summary>GPU 0 at 2 Hz for the run's duration, so the caller can judge the steady window (t ≥ 3 s) against the start.</summary>
public sealed record GpuSample(
    long Qpc,
    uint SmMhz,
    uint MemMhz,
    uint PowerMw,
    uint TemperatureC,
    ulong ClocksEventReasons,
    uint PcieGen,
    uint PcieWidth);

/// <summary>The CPU from LibreHardwareMonitor at 2 Hz for a <see cref="LoadKind.Cpu"/> run
/// (empty for the GPU kinds). The first sample is taken before the worker starts, so it is
/// the idle reference. A sensor this box does not expose is null, never 0.</summary>
public sealed record CpuSample(
    long Qpc,
    float? PackageW,
    float? TctlC,
    float? AvgEffectiveMhz,
    float? MaxCoreMhz);
