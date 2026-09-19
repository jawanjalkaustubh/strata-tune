namespace StrataTune.Collector;

/// <summary>Where the handshake and the log go. The UI passes both paths (--handshake, --log)
/// so they land under the launching user's %LOCALAPPDATA%\Strata Tune even when UAC elevated
/// this process under another account (plan section 5, the family PC); without them the
/// elevated identity's own profile is the fallback.</summary>
internal static class AppPaths
{
    private static readonly string DefaultRoot =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Strata Tune");

    public static string Handshake { get; private set; } = Path.Combine(DefaultRoot, "collector.json");

    public static string Log { get; private set; } = Path.Combine(DefaultRoot, "logs", "collector.log");

    public static void Configure(string? handshake, string? log)
    {
        if (!string.IsNullOrWhiteSpace(handshake))
            Handshake = Path.GetFullPath(handshake);
        if (!string.IsNullOrWhiteSpace(log))
            Log = Path.GetFullPath(log);
    }

    /// <summary>Threat: a same-user process that plants a reparse point (a mount point or a
    /// symlink) at the handshake or log directory, or at one of its parents, before this
    /// elevated process creates the real one, can redirect a write we make — with an
    /// administrator's rights — to a path of the attacker's choosing. Walks every path
    /// component that already exists (one that does not exist yet cannot be a reparse point)
    /// and returns the first offender, or null when the chain is clean.</summary>
    public static string? ReparsePointIn(string path)
    {
        for (var dir = new DirectoryInfo(path); dir is not null; dir = dir.Parent)
        {
            if (dir.Exists && dir.Attributes.HasFlag(FileAttributes.ReparsePoint))
                return dir.FullName;
        }
        return null;
    }
}
