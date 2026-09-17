using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace StrataTune.Collector;

/// <summary>The family's gpu.lock (plan section 20), the same file and JSON shape as
/// strata-video's electron/gpu-lock.ts and the bench's GpuLock.cs, held here by the tune
/// supervisor for the length of a run with owner strata-tune. Passive monitoring never
/// takes it; a hunt refuses to start while another app holds it, because background GPU
/// load would trip the validity gate anyway.</summary>
internal sealed record GpuLockEntry(string Holder, int Pid, string Since);

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, WriteIndented = true)]
[JsonSerializable(typeof(GpuLockEntry))]
internal sealed partial class GpuLockJson : JsonSerializerContext;

internal static class FamilyGpuLock
{
    public const string Owner = "strata-tune";

    private static readonly string LockPath = Path.Combine(
        Environment.GetEnvironmentVariable("STRATA_AI_DEV") ?? @"C:\AI_dev", "Claude", ".strata", "gpu.lock");

    /// <summary>Who holds the GPU as a plain sentence, or null when it is free. A lock whose
    /// pid is gone is a crash leftover and is cleared so nobody waits on a ghost.</summary>
    public static string? HeldBy()
    {
        var entry = Read();
        if (entry is null)
            return null;
        if (!PidAlive(entry.Pid))
        {
            TryDelete();
            return null;
        }
        return entry.Pid == Environment.ProcessId
            ? null
            : $"{Label(entry.Holder)} is using the GPU (pid {entry.Pid}); a tune run needs the card to itself.";
    }

    public static void Take()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(LockPath)!);
        File.WriteAllText(LockPath, JsonSerializer.Serialize(new GpuLockEntry(Owner, Environment.ProcessId, DateTime.UtcNow.ToString("o")), GpuLockJson.Default.GpuLockEntry));
    }

    /// <summary>Deletes the lock only when it is still ours: a newer holder's file is never taken down by an instance exiting late.</summary>
    public static void Release()
    {
        if (Read() is { Holder: Owner } entry && entry.Pid == Environment.ProcessId)
            TryDelete();
    }

    private static GpuLockEntry? Read()
    {
        try
        {
            return File.Exists(LockPath) ? JsonSerializer.Deserialize(File.ReadAllText(LockPath), GpuLockJson.Default.GpuLockEntry) : null;
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
            File.Delete(LockPath);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
        }
    }

    private static bool PidAlive(int pid)
    {
        if (pid <= 0)
            return false;
        try
        {
            using var process = Process.GetProcessById(pid);
            return !process.HasExited;
        }
        catch (Exception e) when (e is ArgumentException or InvalidOperationException)
        {
            return false;
        }
        catch (System.ComponentModel.Win32Exception)
        {
            // Exists but cannot be queried (a sibling at another integrity level): alive, same rule as presence.ts.
            return true;
        }
    }

    private static string Label(string holder) => holder switch
    {
        "strata-code" => "Strata Code",
        "strata-photo" => "Strata Photo",
        "strata-video" => "Strata Video",
        "strata-tune-bench" => "The stutter bench",
        Owner => "Another tune run",
        _ => "Another app",
    };
}
