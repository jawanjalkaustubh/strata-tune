namespace StrataTune.Shared;

/// <summary>GET /timers (plan sections 8 and 17, the About hub's Timers tool). The three
/// resolutions are NtQueryTimerResolution's, in milliseconds and named by what they mean:
/// NT's "MinimumResolution" is the coarsest period the platform allows (15.625 ms), its
/// "MaximumResolution" the finest (0.5 ms). <see cref="QpcSource"/> is inferred from the
/// counter frequency, which Windows fixes at boot from the clock it chose (docs: "Acquiring
/// high-resolution time stamps"); <see cref="QpcNote"/> says how far that inference goes.
/// <see cref="Requesters"/> is null unless a trace ran; an empty list after a trace means
/// nobody holds the timer. The resolutions are null only when the kernel call failed.</summary>
public sealed record Timers(
    double? CurrentMs,
    double? FinestMs,
    double? CoarsestMs,
    long QpcFrequency,
    string QpcSource,
    string QpcNote,
    IReadOnlyList<TimerRequester>? Requesters,
    string? RequestersNote);

/// <summary>One outstanding timer-resolution request as powercfg's energy trace lists it.
/// <see cref="Own"/> marks this app's own processes (the UI's Chromium raises the timer
/// while it animates), so an audit never names Strata Tune as the background app.</summary>
public sealed record TimerRequester(int Pid, string Name, string? Path, double? PeriodMs, bool Own);
