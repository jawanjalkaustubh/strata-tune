using System.Diagnostics;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;
using StrataTune.Shared;

namespace StrataTune.Collector;

/// <summary>The port-and-token file the UI polls for. Written to a per-process temp file and
/// moved into place so a reader never sees a half-written JSON document and two starting
/// instances never share a temp name.</summary>
internal static class HandshakeFile
{
    public const string CollectorProcessName = "strata-tune-collector";

    public static void Write(Handshake handshake, Action<string> log)
    {
        var dir = Path.GetDirectoryName(AppPaths.Handshake)!;
        // Refuse a redirected write (see AppPaths.ReparsePointIn) rather than follow it.
        if (AppPaths.ReparsePointIn(dir) is { } reparse)
        {
            log($"handshake: refusing to write under {dir}: {reparse} is a reparse point");
            return;
        }
        Directory.CreateDirectory(dir);
        var temp = $"{AppPaths.Handshake}.{Environment.ProcessId}.tmp";
        File.WriteAllBytes(temp, JsonSerializer.SerializeToUtf8Bytes(handshake, WireJson.Default.Handshake));
        File.Move(temp, AppPaths.Handshake, overwrite: true);
        SecureFile(AppPaths.Handshake, log);
    }

    /// <summary>Threat: the token this file carries. The DACL goes on the file, not on the
    /// folder: %LOCALAPPDATA%\Strata Tune is shared with the unelevated UI, which writes the
    /// disclaimer acceptance and its own logs there, so a Users-read-only folder would break
    /// the app. On the file: inheritance cut, administrators and SYSTEM full control, and the
    /// collector's own SID read — the elevated process runs as the same account the unelevated
    /// Electron UI does, so the UI can still poll the file while no other principal is named.
    /// The peer-process check in <see cref="Auth"/> is the real guard against a same-user
    /// process that reads the token anyway; this narrows who can.</summary>
    private static void SecureFile(string file, Action<string> log)
    {
        try
        {
            var administrators = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
            var security = new FileSecurity();
            security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
            security.SetOwner(administrators);
            security.AddAccessRule(new FileSystemAccessRule(administrators, FileSystemRights.FullControl, InheritanceFlags.None, PropagationFlags.None, AccessControlType.Allow));
            security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
                FileSystemRights.FullControl, InheritanceFlags.None, PropagationFlags.None, AccessControlType.Allow));
            if (WindowsIdentity.GetCurrent().User is { } self)
                security.AddAccessRule(new FileSystemAccessRule(self, FileSystemRights.Read, InheritanceFlags.None, PropagationFlags.None, AccessControlType.Allow));
            new FileInfo(file).SetAccessControl(security);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or InvalidOperationException)
        {
            log($"handshake: could not restrict the ACL of collector.json: {e.Message}");
        }
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
