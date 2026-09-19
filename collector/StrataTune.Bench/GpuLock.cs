using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace StrataTune.Bench;

/// <summary>The family's gpu.lock (plan section 20): the same file and JSON shape as
/// strata-video's electron/gpu-lock.ts, written here with owner strata-tune-bench.</summary>
internal sealed record LockEntry(string Holder, int Pid, string Since);

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, WriteIndented = true)]
[JsonSerializable(typeof(LockEntry))]
internal sealed partial class LockJson : JsonSerializerContext;

internal static class GpuLock
{
    public const string Owner = "strata-tune-bench";

    private static readonly string Path = System.IO.Path.Combine(
        Environment.GetEnvironmentVariable("STRATA_AI_DEV") ?? @"C:\AI_dev", "Claude", ".strata", "gpu.lock");

    /// <summary>Who holds the GPU right now as a plain sentence, or null when the lock is free.
    /// A lock whose pid is gone is a crash leftover and is cleared so nobody waits on a ghost.</summary>
    public static string? HeldBy()
    {
        LockEntry? entry = Read();
        if (entry is null)
        {
            return null;
        }

        if (!PidAlive(entry.Pid))
        {
            TryDelete();
            return null;
        }

        return entry.Pid == Environment.ProcessId
            ? null
            : $"{Label(entry.Holder)} is using the GPU (pid {entry.Pid}); the bench needs the card to itself.";
    }

    public static void Take()
    {
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(Path)!);
        LockEntry entry = new(Owner, Environment.ProcessId, DateTime.UtcNow.ToString("o"));
        File.WriteAllText(Path, JsonSerializer.Serialize(entry, LockJson.Default.LockEntry));
    }

    /// <summary>Deletes the lock only when it is still ours: a newer holder's file is never taken down by an instance exiting late.</summary>
    public static void Release()
    {
        LockEntry? entry = Read();
        if (entry is { Holder: Owner } && entry.Pid == Environment.ProcessId)
        {
            TryDelete();
        }
    }

    private static LockEntry? Read()
    {
        try
        {
            return File.Exists(Path) ? JsonSerializer.Deserialize(File.ReadAllText(Path), LockJson.Default.LockEntry) : null;
        }
        catch (Exception e) when (e is IOException or JsonException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    private static void TryDelete()
    {
        try
        {
            File.Delete(Path);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            // Another instance may have already removed it; nothing to do.
        }
    }

    private static bool PidAlive(int pid)
    {
        if (pid <= 0)
        {
            return false;
        }

        try
        {
            using Process process = Process.GetProcessById(pid);
            return !process.HasExited;
        }
        catch (Exception e) when (e is ArgumentException or InvalidOperationException)
        {
            return false;
        }
        catch (System.ComponentModel.Win32Exception)
        {
            // Exists but cannot be queried (an elevated sibling): alive, same rule as presence.ts.
            return true;
        }
    }

    private static string Label(string holder) => holder switch
    {
        "strata-code" => "Strata Code",
        "strata-photo" => "Strata Photo",
        "strata-video" => "Strata Video",
        "strata-tune" => "Strata Tune",
        Owner => "Another bench run",
        _ => "Another app",
    };
}
