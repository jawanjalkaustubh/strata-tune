using System.Security.AccessControl;
using System.Security.Principal;

namespace StrataTune.Collector;

/// <summary>The one ACL rule behind two doors an elevated process must keep shut: the exe
/// the logon task runs (collector/README.md, "where the collector may be installed") and
/// the state folder whose file that task trusts for the values it applies. Both are "only
/// administrators write": a standard user who can replace the exe, or edit the file, runs
/// their own code or their own clock offsets as administrator at the next logon. The check
/// is on the DACL and the owner, not on the path, so a Program Files install passes and a
/// portable copy in Downloads (or a dev tree on a drive that grants Authenticated Users
/// Modify at its root) is refused whatever it is called.</summary>
internal static class AdminOnly
{
    private static readonly SecurityIdentifier Administrators = new(WellKnownSidType.BuiltinAdministratorsSid, null);
    private static readonly SecurityIdentifier System = new(WellKnownSidType.LocalSystemSid, null);
    private static readonly SecurityIdentifier Users = new(WellKnownSidType.BuiltinUsersSid, null);
    // NT SERVICE\TrustedInstaller owns Program Files and everything Windows installs there.
    private static readonly SecurityIdentifier TrustedInstaller = new("S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464");

    // Anything that replaces, renames or re-permissions the object itself.
    private const FileSystemRights WriteRights = FileSystemRights.WriteData | FileSystemRights.AppendData | FileSystemRights.Delete
        | FileSystemRights.DeleteSubdirectoriesAndFiles | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership;
    // On a parent, deleting or renaming a child needs FILE_DELETE_CHILD there, and WRITE_DAC
    // or ownership gets it; plain create rights on a parent (ProgramData, the drive root)
    // cannot touch an existing subfolder, so they pass.
    private const FileSystemRights ParentRights = FileSystemRights.DeleteSubdirectoriesAndFiles | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership;

    /// <summary>Why this exe must not be run elevated at logon, or null when its file, its
    /// folder and every parent up to the root are writable by administrators alone.</summary>
    public static string? ExeProblem(string exePath)
    {
        try
        {
            var full = Path.GetFullPath(exePath);
            var dir = Path.GetDirectoryName(full);
            if (dir is null)
                return $"{full} has no parent directory";
            return Problem(new FileInfo(full).GetAccessControl(), full, WriteRights)
                ?? Problem(new DirectoryInfo(dir).GetAccessControl(), dir, WriteRights)
                ?? ParentsProblem(dir);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or InvalidOperationException)
        {
            return $"the ACL of {exePath} could not be read: {e.Message}";
        }
    }

    /// <summary>The state folder and its file: repaired to the restricted DACL when anyone
    /// else could write them (an installer, an older build or a standard user may have
    /// created the folder first, with ProgramData's inheritance intact), and the reason when
    /// even the repair fails, which is when Tune must refuse to trust the file.</summary>
    public static string? EnforceFolder(string dir, string? file, Action<string> log)
    {
        try
        {
            var info = new DirectoryInfo(dir);
            if (!info.Exists)
                return null;
            var problem = Problem(info.GetAccessControl(), dir, WriteRights);
            if (problem is null && file is not null && File.Exists(file))
                problem = Problem(new FileInfo(file).GetAccessControl(), file, WriteRights);
            if (problem is null)
                return null;
            log($"tune: {problem}; restricting it to administrators");
            info.SetAccessControl(Restricted());
            if (file is not null && File.Exists(file))
                new FileInfo(file).SetAccessControl(Restrict(new FileSecurity(), InheritanceFlags.None));
            return Problem(info.GetAccessControl(), dir, WriteRights)
                ?? (file is not null && File.Exists(file) ? Problem(new FileInfo(file).GetAccessControl(), file, WriteRights) : null);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or InvalidOperationException)
        {
            return $"the ACL of {dir} could not be repaired: {e.Message}";
        }
    }

    /// <summary>Administrators and SYSTEM write, Users read; inheritance cut.</summary>
    public static DirectorySecurity Restricted() =>
        Restrict(new DirectorySecurity(), InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit);

    private static T Restrict<T>(T security, InheritanceFlags inherit) where T : FileSystemSecurity
    {
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        security.SetOwner(Administrators);
        security.AddAccessRule(new FileSystemAccessRule(Administrators, FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
        security.AddAccessRule(new FileSystemAccessRule(System, FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
        security.AddAccessRule(new FileSystemAccessRule(Users, FileSystemRights.ReadAndExecute, inherit, PropagationFlags.None, AccessControlType.Allow));
        return security;
    }

    private static string? ParentsProblem(string dir)
    {
        for (var parent = Directory.GetParent(dir); parent is not null; parent = parent.Parent)
        {
            if (Problem(parent.GetAccessControl(), parent.FullName, ParentRights) is { } problem)
                return problem;
        }
        return null;
    }

    // Effective rights per principal (allow minus deny) against the mask; the owner is
    // implicitly able to re-permission the object, so it must be an administrator too.
    private static string? Problem(FileSystemSecurity security, string path, FileSystemRights mask)
    {
        if (security.GetOwner(typeof(SecurityIdentifier)) is SecurityIdentifier owner && !Trusted(owner))
            return $"{Name(owner)} owns {path}";
        var allowed = new Dictionary<SecurityIdentifier, FileSystemRights>();
        var denied = new Dictionary<SecurityIdentifier, FileSystemRights>();
        foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier)))
        {
            if (rule.PropagationFlags.HasFlag(PropagationFlags.InheritOnly))
                continue;
            var sid = (SecurityIdentifier)rule.IdentityReference;
            var table = rule.AccessControlType == AccessControlType.Allow ? allowed : denied;
            table[sid] = table.GetValueOrDefault(sid) | rule.FileSystemRights;
        }
        foreach (var (sid, rights) in allowed)
        {
            if (Trusted(sid))
                continue;
            var effective = (rights & ~denied.GetValueOrDefault(sid)) & mask;
            if (effective != 0)
                return $"{Name(sid)} may write {path} ({effective})";
        }
        return null;
    }

    private static bool Trusted(SecurityIdentifier sid) => sid == Administrators || sid == System || sid == TrustedInstaller;

    private static string Name(SecurityIdentifier sid)
    {
        try
        {
            return sid.Translate(typeof(NTAccount)).Value;
        }
        catch (IdentityNotMappedException)
        {
            return sid.Value;
        }
    }
}
