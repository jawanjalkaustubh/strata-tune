using System.Text.Json.Serialization;

namespace StrataTune.Shared;

public enum LoadKind
{
    [JsonStringEnumMemberName("light")] Light,
    [JsonStringEnumMemberName("heavy")] Heavy,
}

public enum LoadRunState
{
    [JsonStringEnumMemberName("running")] Running,
    [JsonStringEnumMemberName("done")] Done,
    [JsonStringEnumMemberName("failed")] Failed,
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
    string? Error);

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
