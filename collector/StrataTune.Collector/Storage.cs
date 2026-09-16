using System.Globalization;
using System.Text.RegularExpressions;
using StrataTune.Shared;

namespace StrataTune.Collector;

/// <summary>Physical disks from the Storage namespace and fixed volumes from DriveInfo, joined
/// so the audit can tell which disk a path lives on (plan section 7).</summary>
internal static partial class Storage
{
    public static List<PhysicalDisk> Disks(Log log) =>
        Wmi.Query(Wmi.Storage, "SELECT DeviceId, FriendlyName, MediaType, BusType, Size FROM MSFT_PhysicalDisk",
                r => new PhysicalDisk(
                    Wmi.Text(r, "DeviceId"), Wmi.Text(r, "FriendlyName"),
                    Media(Wmi.Number(r, "MediaType")), Bus(Wmi.Number(r, "BusType")), Wmi.Number(r, "Size")), log)
            .OrderBy(d => d.DeviceId.Length).ThenBy(d => d.DeviceId, StringComparer.Ordinal)
            .ToList();

    public static List<Volume> Volumes(IReadOnlyList<PhysicalDisk> disks, Log log)
    {
        var diskOfLetter = DiskOfLetter(disks, log);
        var boot = char.ToUpperInvariant(Environment.SystemDirectory[0]);
        var volumes = new List<Volume>();
        foreach (var drive in DriveInfo.GetDrives())
        {
            try
            {
                if (drive.DriveType != DriveType.Fixed || !drive.IsReady)
                    continue;
                var letter = char.ToUpperInvariant(drive.Name[0]);
                volumes.Add(new Volume(
                    letter.ToString(), Printable.Text(drive.VolumeLabel), drive.DriveFormat,
                    drive.TotalSize, drive.AvailableFreeSpace, letter == boot, diskOfLetter.GetValueOrDefault(letter)));
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                log.Write($"volume {drive.Name}: {e.GetType().Name}: {e.Message}");
            }
        }
        return volumes;
    }

    // C: → "Disk #2, Partition #4" → \\.\PHYSICALDRIVE2 → Win32_DiskDrive.Index 2 →
    // MSFT_Disk.Number 2 → the MSFT_PhysicalDisk with the same UniqueId. On a plain box that
    // physical disk's DeviceId is also "2", which is the fallback when the Storage namespace
    // does not answer; a volume nothing maps stays null rather than guessed.
    private static Dictionary<char, string> DiskOfLetter(IReadOnlyList<PhysicalDisk> disks, Log log)
    {
        var partitionOfLetter = Wmi.Query(Wmi.Cimv2, "SELECT Antecedent, Dependent FROM Win32_LogicalDiskToPartition",
            r => (Partition: KeyOf(r["Antecedent"]), Letter: KeyOf(r["Dependent"])), log);
        var driveOfPartition = Wmi.Query(Wmi.Cimv2, "SELECT Antecedent, Dependent FROM Win32_DiskDriveToDiskPartition",
            r => (Drive: KeyOf(r["Antecedent"]), Partition: KeyOf(r["Dependent"])), log)
            .ToLookup(p => p.Partition, p => p.Drive, StringComparer.OrdinalIgnoreCase);
        var indexOfDrive = Wmi.Query(Wmi.Cimv2, "SELECT DeviceID, Index FROM Win32_DiskDrive",
            r => (Drive: Wmi.Text(r, "DeviceID"), Index: Wmi.Number(r, "Index")), log)
            .ToLookup(d => d.Drive, d => d.Index, StringComparer.OrdinalIgnoreCase);
        var uniqueOfNumber = Wmi.Query(Wmi.Storage, "SELECT Number, UniqueId FROM MSFT_Disk",
            r => (Number: Wmi.Number(r, "Number"), UniqueId: Wmi.Text(r, "UniqueId")), log)
            .ToLookup(d => d.Number, d => d.UniqueId);
        var deviceOfUnique = Wmi.Query(Wmi.Storage, "SELECT DeviceId, UniqueId FROM MSFT_PhysicalDisk",
            r => (UniqueId: Wmi.Text(r, "UniqueId"), DeviceId: Wmi.Text(r, "DeviceId")), log)
            .ToLookup(d => d.UniqueId, d => d.DeviceId, StringComparer.OrdinalIgnoreCase);

        var result = new Dictionary<char, string>();
        foreach (var (partition, letter) in partitionOfLetter)
        {
            if (letter.Length == 0)
                continue;
            var index = driveOfPartition[partition].SelectMany(drive => indexOfDrive[drive]).Cast<long?>().FirstOrDefault();
            if (index is null)
                continue;
            var deviceId = uniqueOfNumber[index.Value].SelectMany(unique => deviceOfUnique[unique]).FirstOrDefault()
                ?? index.Value.ToString(CultureInfo.InvariantCulture);
            if (disks.Any(d => d.DeviceId == deviceId))
                result[char.ToUpperInvariant(letter[0])] = deviceId;
        }
        return result;
    }

    // Association endpoints are object paths such as
    // \\HOST\root\cimv2:Win32_DiskDrive.DeviceID="\\\\.\\PHYSICALDRIVE2" — the key value,
    // with the path syntax's backslash escaping undone, is all that is needed.
    private static string KeyOf(object? reference)
    {
        var match = KeyValue().Match(reference?.ToString() ?? "");
        return match.Success ? match.Groups[1].Value.Replace(@"\\", @"\") : "";
    }

    private static MediaType Media(long value) => value switch
    {
        3 => MediaType.Hdd,
        4 => MediaType.Ssd,
        5 => MediaType.Scm,
        _ => MediaType.Unspecified,
    };

    private static string Bus(long value) => value switch
    {
        1 => "SCSI", 2 => "ATAPI", 3 => "ATA", 4 => "1394", 5 => "SSA", 6 => "Fibre Channel",
        7 => "USB", 8 => "RAID", 9 => "iSCSI", 10 => "SAS", 11 => "SATA", 12 => "SD", 13 => "MMC",
        14 => "Virtual", 15 => "File Backed Virtual", 16 => "Storage Spaces", 17 => "NVMe", 18 => "SCM",
        _ => "Unknown",
    };

    [GeneratedRegex("DeviceID=\"([^\"]*)\"")]
    private static partial Regex KeyValue();
}
