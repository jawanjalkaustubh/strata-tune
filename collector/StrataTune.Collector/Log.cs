using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace StrataTune.Collector;

/// <summary>One line per event in a small text log that rolls over once. Logging must never
/// take the service down, so a file that cannot be written is silently skipped; and the
/// token never goes through here.</summary>
internal sealed class Log
{
    private const long RollBytes = 1 << 20;
    private const int VolumeNameDos = 0;

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern int GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, int size, int flags);

    private readonly string _path;
    private readonly string _rolled;
    private readonly string _dir;
    private readonly Lock _gate = new();
    // The handle every line goes through for this process's life. Checking the directory
    // once and then re-opening the path per line (File.AppendAllText) is a TOCTOU: the
    // launching user owns this directory, so between two lines they can delete it and leave
    // a junction in its place, and the next line follows it with an administrator's rights.
    // A handle cannot be redirected after it is open, and it keeps the directory alive, so
    // the one check that matters is the one the handle itself is proved against below.
    // Null means logging is off for this process, which is never fatal.
    private FileStream? _stream;

    public Log(string path)
    {
        _path = path;
        _rolled = Path.ChangeExtension(path, ".1.log");
        _dir = Path.GetDirectoryName(path)!;
        _stream = Open();
    }

    public void Write(string line)
    {
        try
        {
            lock (_gate)
            {
                if (_stream is null)
                    return;
                if (_stream.Length > RollBytes)
                    Roll();
                if (_stream is null)
                    return;
                _stream.Write(Encoding.UTF8.GetBytes($"{DateTimeOffset.UtcNow:yyyy-MM-dd'T'HH:mm:ss.fff'Z'} {line}\n"));
                _stream.Flush();
            }
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
        }
    }

    // Refuse a redirected write (see AppPaths.ReparsePointIn) rather than follow it; there
    // is nowhere left to log this to, so it goes to stderr, same as a genuinely orphaned
    // start. The chain check races whoever owns the directory, so it is not trusted on its
    // own: the opened handle is asked where it actually landed, and anything but the file we
    // meant — a junction swapped in after the check, a symlink in the file's place — is let
    // go of unwritten.
    private FileStream? Open()
    {
        try
        {
            if (AppPaths.ReparsePointIn(_dir) is { } reparse)
            {
                Console.Error.WriteLine($"log: refusing to write under {_dir}: {reparse} is a reparse point");
                return null;
            }
            Directory.CreateDirectory(_dir);
            // FileShare as wide as the old per-line appends, minus nothing: another verb's
            // process may hold the same log, and Delete keeps the roll below able to move it.
            var stream = new FileStream(_path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete);
            var final = FinalPathOf(stream);
            if (final is null || !string.Equals(final, _path, StringComparison.OrdinalIgnoreCase))
            {
                Console.Error.WriteLine($"log: refusing to write {_path}: it resolved to {final ?? "a path Windows will not name"}");
                stream.Dispose();
                return null;
            }
            return stream;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            Console.Error.WriteLine($"log: {_path} cannot be opened: {e.Message}");
            return null;
        }
    }

    // The roll has to let go of the handle to move the file, so it takes a new one through
    // the same proof afterwards: a directory swapped in while it was open turns logging off
    // instead of redirecting it.
    private void Roll()
    {
        _stream!.Dispose();
        _stream = null;
        try
        {
            if (AppPaths.ReparsePointIn(_dir) is null)
                File.Move(_path, _rolled, overwrite: true);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
        }
        _stream = Open();
    }

    // Where the handle really is, with the \\?\ prefix the API returns stripped so it can be
    // compared with the path we asked for; null when Windows will not say, which counts as
    // unproven and so as unusable.
    private static string? FinalPathOf(FileStream stream)
    {
        var buffer = new StringBuilder(1024);
        var length = GetFinalPathNameByHandleW(stream.SafeFileHandle, buffer, buffer.Capacity, VolumeNameDos);
        if (length <= 0 || length >= buffer.Capacity)
            return null;
        var final = buffer.ToString();
        return final.StartsWith(@"\\?\", StringComparison.Ordinal) ? final[4..] : final;
    }
}
