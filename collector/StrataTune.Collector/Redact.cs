using System.Text.RegularExpressions;

namespace StrataTune.Collector;

/// <summary>Takes the persistent machine identifiers out of LibreHardwareMonitor's
/// <c>GetReport()</c> text: serial numbers, the raw SMBIOS table (whose base64 carries the
/// board serial, both DIMM serials and the system UUID that licensing and MDM tools key on)
/// and the instance id at the tail of a PCI device path, which on an NVIDIA card is the
/// PCIe device serial number. The same report text becomes the shareable HTML report in
/// plan section 19, so it is stripped where it is produced rather than where it is shared.
/// Everything the go/no-go evidence needs — chips, sensors, registers — survives.</summary>
internal static partial class Redact
{
    private const string Removed = "<redacted>";

    public static string Report(string report)
    {
        var output = new StringWriter();
        var inSmbiosTable = false;

        foreach (var line in report.ReplaceLineEndings("\n").Split('\n'))
        {
            // The base64 dump runs from its heading to the next section rule.
            if (inSmbiosTable)
            {
                if (!line.StartsWith("----", StringComparison.Ordinal))
                    continue;
                inSmbiosTable = false;
            }
            else if (line.TrimEnd() == "SMBios Table")
            {
                output.WriteLine($"SMBios Table {Removed} (raw table: board and DIMM serials, system UUID)");
                output.WriteLine();
                inSmbiosTable = true;
                continue;
            }

            output.WriteLine(Printable.Text(Line(line)));
        }

        return output.ToString();
    }

    private static string Line(string line)
    {
        if (SerialLine().IsMatch(line))
            return SerialLine().Replace(line, $"${{key}}: {Removed}");

        line = PciUdid().Replace(line, $"${{head}}_{Removed}");
        return PciInstance().Replace(line, $"${{head}}${{sep}}{Removed}");
    }

    [GeneratedRegex(@"^(?<key>[^:]*\bSerial(?:\s*Number)?)\s*:.*$", RegexOptions.IgnoreCase)]
    private static partial Regex SerialLine();

    // \\?\PCI#VEN_10DE&DEV_2B85&SUBSYS_89EC1043&REV_A1#<instance>#{guid} and PCI\VEN_…\<instance>
    [GeneratedRegex(@"(?<head>PCI[#\\]VEN_[0-9A-F]{4}[^#\\\s]*)(?<sep>[#\\])(?<id>[^#\\\s]+)", RegexOptions.IgnoreCase)]
    private static partial Regex PciInstance();

    // The same id in LHM's UDID spelling: PCI_VEN_10DE&…&REV_A1_<instance>
    [GeneratedRegex(@"(?<head>PCI_VEN_[0-9A-F]{4}&\S*?REV_[0-9A-F]{2})_\S+", RegexOptions.IgnoreCase)]
    private static partial Regex PciUdid();
}
