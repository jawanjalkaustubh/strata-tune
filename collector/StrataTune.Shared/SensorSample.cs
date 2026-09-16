namespace StrataTune.Shared;

/// <summary>One reading of one sensor. <see cref="Qpc"/> is Stopwatch.GetTimestamp() at read
/// time — the same clock PresentMon stamps frames with, so streams can be joined by time.</summary>
public sealed record SensorSample(long Qpc, string Id, float Value);
