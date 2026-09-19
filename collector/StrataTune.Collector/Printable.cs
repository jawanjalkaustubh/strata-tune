namespace StrataTune.Collector;

/// <summary>Makes a string that came from hardware safe to put in a text file. Seen on this
/// box: one DIMM's SPD part number read back as "G Skill Intl - F5-6\r\0\0…" while the
/// identical DIMM in the other channel read cleanly, which is enough to put NUL bytes into
/// the probe report — and later into the HTML report and the JSON streams.</summary>
internal static class Printable
{
    private const char Replacement = '�';

    public static string Text(string value) =>
        value.Any(Unwanted) ? new string(value.Select(c => Unwanted(c) ? Replacement : c).ToArray()) : value;

    private static bool Unwanted(char c) => char.IsControl(c) && c != '\t';
}
