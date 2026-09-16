namespace StrataTune.Collector;

/// <summary>Runs one source's sampler at a fixed period on its own task, so a slow source
/// never holds up another. A sample that throws is logged once a minute and the loop goes
/// on: one bad read is a gap in the stream, not the end of it.</summary>
internal static class SampleLoop
{
    private static readonly TimeSpan ErrorLogGap = TimeSpan.FromMinutes(1);

    public static async Task RunAsync(string name, TimeSpan period, Action sample, Log log, CancellationToken stopping)
    {
        using var timer = new PeriodicTimer(period);
        var lastError = DateTimeOffset.MinValue;
        try
        {
            while (await timer.WaitForNextTickAsync(stopping))
            {
                try
                {
                    sample();
                }
                catch (Exception e)
                {
                    var now = DateTimeOffset.UtcNow;
                    if (now - lastError > ErrorLogGap)
                    {
                        log.Write($"{name}: {e.GetType().Name}: {e.Message}");
                        lastError = now;
                    }
                }
            }
        }
        catch (OperationCanceledException)
        {
        }
    }
}
