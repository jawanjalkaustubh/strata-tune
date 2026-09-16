namespace StrataTune.Shared;

/// <summary>GET /health. <see cref="QpcFrequency"/> converts every qpc stamp in the other
/// types; <see cref="StartedAt"/> is the one wall-clock value, for display only.
/// <see cref="Warming"/> is true while the sensor groups are still being opened in the
/// background: the service answers and streams from the first moment, and the sensor list
/// grows until this turns false (phase1-polish item 8).</summary>
public sealed record Health(
    bool Ok,
    int Pid,
    string Version,
    bool Elevated,
    PawnIoHealth PawnIo,
    NvmlHealth Nvml,
    SourceHealth Lhm,
    SourceHealth Pdh,
    long QpcFrequency,
    string StartedAt,
    double Uptime,
    bool Warming);

/// <summary><see cref="Installed"/> is whether the driver's device actually opened, not the
/// registry entry: the entry answers true from a non-elevated shell while every CPU and
/// board sensor would read 0.</summary>
public sealed record PawnIoHealth(bool Installed, string? Version);

public sealed record NvmlHealth(bool Available, string? Driver);

/// <summary>A sampler that failed to open at start is reported here and left out of the
/// stream, never served as zeros; the others keep flowing.</summary>
public sealed record SourceHealth(bool Available);

/// <summary>Written to %LOCALAPPDATA%\Strata Tune\collector.json once the server listens;
/// an elevated child cannot pipe stdout to its non-elevated parent, so this file is the
/// handshake (plan section 5).</summary>
public sealed record Handshake(int Port, string Token, int Pid, string StartedAt);

/// <summary>Body of every non-2xx JSON response.</summary>
public sealed record ApiError(string Error);
