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
    /// the app. On the file: inheritance cut, administrators and SYSTEM full control, and read
    /// for the collector's own SID plus the launching user's — usually one and the same account,
    /// but when UAC elevated this process under another one (plan section 5, the family PC) the
    /// standard user who runs the UI is a different principal and without its ACE the UI polls
    /// a file it may not read, forever. No other principal is named. The peer-process check in
    /// <see cref="Auth"/> is the real guard against a same-user process that reads the token
    /// anyway; this narrows who can.</summary>
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
            var self = WindowsIdentity.GetCurrent().User;
            if (self is not null)
                security.AddAccessRule(new FileSystemAccessRule(self, FileSystemRights.Read, InheritanceFlags.None, PropagationFlags.None, AccessControlType.Allow));
            if (LaunchingUser(Path.GetDirectoryName(file)!, self) is { } launcher)
                security.AddAccessRule(new FileSystemAccessRule(launcher, FileSystemRights.Read, InheritanceFlags.None, PropagationFlags.None, AccessControlType.Allow));
            new FileInfo(file).SetAccessControl(security);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or InvalidOperationException)
        {
            log($"handshake: could not restrict the ACL of collector.json: {e.Message}");
        }
    }

    /// <summary>The account the UI runs as, taken from the first directory on the handshake's
    /// path that neither this elevated identity, Administrators nor SYSTEM owns: the UI passes
    /// --handshake under its own %LOCALAPPDATA%, so on the elevated-under-another-account path
    /// that is the launching user's profile folder. Folders an earlier elevated run created are
    /// skipped for that reason. Null when the whole chain is ours (the ordinary case, where the
    /// collector's own SID above is already the launching user) or when the owners cannot be
    /// read — never a reason to leave the file's inherited ACL in place, so this has its own
    /// try and does not share the caller's.</summary>
    private static SecurityIdentifier? LaunchingUser(string dir, SecurityIdentifier? self)
    {
        var administrators = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
        var system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
        try
        {
            for (var d = new DirectoryInfo(dir); d is not null; d = d.Parent)
            {
                if (!d.Exists)
                    continue;
                // An account, never a service: the walk reaches the volume root on the ordinary
                // single-account box (C:\ is owned by NT SERVICE\TrustedInstaller on a stock
                // install), and that is a chain with no launching user in it rather than a
                // principal to name on the token file.
                if (d.GetAccessControl().GetOwner(typeof(SecurityIdentifier)) is SecurityIdentifier owner
                    && owner.IsAccountSid() && owner != administrators && owner != system && owner != self)
                    return owner;
            }
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or InvalidOperationException or ArgumentException)
        {
        }
        return null;
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
