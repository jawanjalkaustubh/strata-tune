namespace StrataTune.Collector;

/// <summary>One line per event in a small text log that rolls over once. Logging must never
/// take the service down, so a file that cannot be written is silently skipped; and the
/// token never goes through here.</summary>
internal sealed class Log
{
    private const long RollBytes = 1 << 20;

    private readonly string _path;
    private readonly string _rolled;
    private readonly Lock _gate = new();
    // Set once at construction when the log directory's chain is not safe to write under
    // (see AppPaths.ReparsePointIn); checked once, not on every Write, since Write runs on
    // a hot path and the directory does not change after this.
    private readonly bool _blocked;

    public Log(string path)
    {
        _path = path;
        _rolled = Path.ChangeExtension(path, ".1.log");
        var dir = Path.GetDirectoryName(path)!;
        // Refuse a redirected write (see AppPaths.ReparsePointIn) rather than follow it; there
        // is nowhere left to log this to, so it goes to stderr, same as a genuinely orphaned start.
        if (AppPaths.ReparsePointIn(dir) is { } reparse)
        {
            Console.Error.WriteLine($"log: refusing to write under {dir}: {reparse} is a reparse point");
            _blocked = true;
            return;
        }
        Directory.CreateDirectory(dir);
    }

    public void Write(string line)
    {
        if (_blocked)
            return;
        try
        {
            lock (_gate)
            {
                if (File.Exists(_path) && new FileInfo(_path).Length > RollBytes)
                    File.Move(_path, _rolled, overwrite: true);
                File.AppendAllText(_path, $"{DateTimeOffset.UtcNow:yyyy-MM-dd'T'HH:mm:ss.fff'Z'} {line}\n");
            }
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
        }
    }
}
