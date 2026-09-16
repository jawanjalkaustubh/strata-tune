using System.Diagnostics;
using System.Text.Json;
using StrataTune.Shared;

namespace StrataTune.Collector;

/// <summary>The port-and-token file the UI polls for. Written to a per-process temp file and
/// moved into place so a reader never sees a half-written JSON document and two starting
/// instances never share a temp name.</summary>
internal static class HandshakeFile
{
    public const string CollectorProcessName = "strata-tune-collector";

    public static void Write(Handshake handshake)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(AppPaths.Handshake)!);
        var temp = $"{AppPaths.Handshake}.{Environment.ProcessId}.tmp";
        File.WriteAllBytes(temp, JsonSerializer.SerializeToUtf8Bytes(handshake, WireJson.Default.Handshake));
        File.Move(temp, AppPaths.Handshake, overwrite: true);
    }

    /// <summary>The pid in the existing file when it names another running collector: a live
    /// collector is never doubled, on this side as well as the UI's, so a second instance
    /// (a stale UAC prompt answered late, Retry clicked while one is pending) refuses to
    /// start rather than writing over the first one's token.</summary>
    public static int? LiveCollectorPid()
    {
        var current = Read();
        if (current is null || current.Pid == Environment.ProcessId)
            return null;
        try
        {
            using var process = Process.GetProcessById(current.Pid);
            return !process.HasExited && string.Equals(process.ProcessName, CollectorProcessName, StringComparison.OrdinalIgnoreCase)
                ? current.Pid
                : null;
        }
        catch (Exception e) when (e is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            return null;
        }
    }

    /// <summary>Removes the file only when this process wrote it: an instance exiting late must
    /// not take a newer collector's handshake with it.</summary>
    public static void Delete()
    {
        try
        {
            if (Read()?.Pid == Environment.ProcessId)
                File.Delete(AppPaths.Handshake);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
        }
    }

    private static Handshake? Read()
    {
        try
        {
            return JsonSerializer.Deserialize(File.ReadAllBytes(AppPaths.Handshake), WireJson.Default.Handshake);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException)
        {
            return null;
        }
    }
}
