using System.Diagnostics;
using StrataTune.Shared;

namespace StrataTune.Collector;

/// <summary>What the endpoints share: the sources (each null until it opens, or for good
/// when it could not), the buffer, the load runner and the facts /health reports. Built once
/// by <see cref="Serve"/>, before the sources open.</summary>
internal sealed class CollectorState
{
    public required Log Log { get; init; }
    public required RingBuffer Buffer { get; init; }
    public required Sources Sources { get; init; }
    public required LoadRunner Loads { get; init; }
    public required TuneSupervisor Tune { get; init; }
    public required bool PawnIoUsable { get; init; }
    public required string Version { get; init; }
    public required string StartedAt { get; init; }
    public required long StartedQpc { get; init; }
    public required CancellationToken Stopping { get; init; }

    public Health Health() => new(
        Ok: true,
        Pid: Environment.ProcessId,
        Version: Version,
        Elevated: true,
        PawnIo: new PawnIoHealth(PawnIoUsable, Lhm.PawnIoVersion?.ToString()),
        Nvml: new NvmlHealth(Sources.Nvml is not null, Sources.Nvml?.Driver),
        Lhm: new SourceHealth(Sources.Lhm is not null),
        Pdh: new SourceHealth(Sources.Pdh is not null),
        QpcFrequency: Stopwatch.Frequency,
        StartedAt: StartedAt,
        Uptime: (Stopwatch.GetTimestamp() - StartedQpc) / (double)Stopwatch.Frequency,
        Warming: Sources.Warming)
    { Tune = Tune.Health() };

    public SensorMeta[] Metas() =>
        [.. Sources.Lhm?.Metas ?? [], .. Sources.NvmlSampler?.Metas ?? [], .. Sources.Pdh?.Metas ?? []];

    /// <summary>A fresh NVML read, for the endpoints that promise "now". A driver reset or a
    /// card that answers NOT_SUPPORTED on a mandatory call empties the block (the snapshot
    /// contract: one failed class empties that block only), never the whole response.</summary>
    public GpuFacts[] ReadGpus()
    {
        try
        {
            return Sources.Nvml?.Read().ToArray() ?? [];
        }
        catch (InvalidOperationException e)
        {
            Log.Write($"nvml read failed, gpus[] empty: {e.Message}");
            return [];
        }
    }

    public Tick Tick()
    {
        var row = Buffer.Latest();
        return new Tick(row.Qpc, row.Values, Sources.NvmlSampler?.Latest ?? [], Sources.Warming);
    }
}
