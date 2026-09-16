namespace StrataTune.Worker;

/// <summary>
/// Rewrites a file every two seconds so the supervisor can tell a live process from a dead or
/// frozen one by its mtime. It runs on a timer thread, so it keeps ticking while the main
/// thread waits on a fence - which is also its limit: a hung GPU looks exactly like a slow
/// one here, so the supervisor has to pair this with a wall-clock budget per dispatch batch.
/// </summary>
internal sealed class Heartbeat : IDisposable
{
    private static readonly TimeSpan Period = TimeSpan.FromSeconds(2);

    private readonly string path;
    private readonly Timer timer;
    private string? failure;

    /// <summary>The last write that failed, for the run to mention when it ends.</summary>
    public string? Failure => Volatile.Read(ref failure);

    public Heartbeat(string path)
    {
        this.path = path;

        // The first write runs synchronously so an unwritable path fails the run up front.
        Write();

        timer = new Timer(_ => Touch(), null, Period, Period);
    }

    private void Touch()
    {
        try
        {
            Write();
        }
        catch (Exception e)
        {
            // Nothing here may kill a GPU run. This is a timer thread, so an exception that
            // escapes it ends the process outside Main's catch, with an exit code the
            // supervisor cannot read: a sharing violation while the supervisor reads the
            // file, a read-only bit or an ACL change would all do it. The next tick rewrites
            // the file anyway.
            Volatile.Write(ref failure, $"{e.GetType().Name}: {e.Message}");
        }
    }

    private void Write() => File.WriteAllText(path, $"{Environment.ProcessId} {DateTime.UtcNow:O}\n");

    public void Dispose() => timer.Dispose();
}
