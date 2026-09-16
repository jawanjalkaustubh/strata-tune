using System.Globalization;
using System.Management;

namespace StrataTune.Collector;

/// <summary>One WMI query, one mapped list. Any failure — an absent class, a broken
/// provider, a property this OS build lacks — is logged and yields an empty list, so one
/// dead WMI class costs one block of the snapshot rather than the whole capture.</summary>
internal static class Wmi
{
    public const string Cimv2 = @"root\cimv2";
    public const string Storage = @"root\Microsoft\Windows\Storage";

    public static List<T> Query<T>(string scope, string wql, Func<ManagementBaseObject, T> map, Log log)
    {
        try
        {
            using var searcher = new ManagementObjectSearcher(new ManagementScope(scope), new ObjectQuery(wql));
            using var results = searcher.Get();
            var list = new List<T>();
            foreach (var row in results)
                using (row)
                    list.Add(map(row));
            return list;
        }
        catch (Exception e)
        {
            log.Write($"wmi {wql}: {e.GetType().Name}: {e.Message}");
            return [];
        }
    }

    public static string Text(ManagementBaseObject row, string property) =>
        Printable.Text(row[property]?.ToString()?.Trim() ?? "");

    public static long Number(ManagementBaseObject row, string property) =>
        row[property] is { } value ? Convert.ToInt64(value, CultureInfo.InvariantCulture) : 0;

    /// <summary>CIM datetimes are "yyyyMMddHHmmss.ffffff±UUU". The date half is taken as
    /// written, because converting a UTC-midnight release date to local time slips it back a
    /// day everywhere west of Greenwich.</summary>
    public static string? Date(ManagementBaseObject row, string property)
    {
        var text = row[property]?.ToString();
        return text is { Length: >= 8 } && text.AsSpan(0, 8).ContainsAnyExcept("0123456789") is false
            ? $"{text[..4]}-{text[4..6]}-{text[6..8]}"
            : null;
    }
}
