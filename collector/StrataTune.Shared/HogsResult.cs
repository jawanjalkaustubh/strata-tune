namespace StrataTune.Shared;

/// <summary>One process over the idle sample window; <see cref="CpuPercent"/> is of the
/// whole machine (every logical CPU), not of one core.</summary>
public sealed record ProcessSample(int Pid, string Name, double CpuPercent, double WorkingSetMiB);

/// <summary>GET /procs/hogs: sorted by CPU descending, the collector's and the UI's own
/// process trees excluded.</summary>
public sealed record HogsResult(int Seconds, int LogicalCpus, IReadOnlyList<ProcessSample> Processes);
