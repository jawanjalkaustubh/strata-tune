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

    public Log(string path)
    {
        _path = path;
        _rolled = Path.ChangeExtension(path, ".1.log");
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
    }

    public void Write(string line)
    {
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
