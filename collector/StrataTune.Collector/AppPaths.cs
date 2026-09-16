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
}
