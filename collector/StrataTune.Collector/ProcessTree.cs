using System.Runtime.InteropServices;

namespace StrataTune.Collector;

/// <summary>Parent links for every process, from a Toolhelp snapshot: one call, no WMI, and
/// it needs no handle on the processes themselves.</summary>
internal static class ProcessTree
{
    private const uint SnapshotProcesses = 0x2;
    private const int MaxDepth = 64;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessEntry
    {
        public uint Size;
        public uint Usage;
        public uint ProcessId;
        public UIntPtr DefaultHeapId;
        public uint ModuleId;
        public uint Threads;
        public uint ParentProcessId;
        public int PriorityClassBase;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string ExeFile;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry entry);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry entry);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    /// <summary>The given pids plus every process below them in the parent chain.</summary>
    public static HashSet<int> Descendants(IEnumerable<int> roots)
    {
        var parentOf = Parents();
        var set = new HashSet<int>(roots.Where(pid => pid > 0));
        foreach (var pid in parentOf.Keys)
        {
            var cursor = pid;
            for (var depth = 0; depth < MaxDepth && parentOf.TryGetValue(cursor, out var parent) && parent != cursor; depth++)
            {
                if (set.Contains(parent))
                {
                    set.Add(pid);
                    break;
                }
                cursor = parent;
            }
        }
        return set;
    }

    private static Dictionary<int, int> Parents()
    {
        var parents = new Dictionary<int, int>();
        var snapshot = CreateToolhelp32Snapshot(SnapshotProcesses, 0);
        if (snapshot == IntPtr.Zero || snapshot == new IntPtr(-1))
            return parents;
        try
        {
            var entry = new ProcessEntry { Size = (uint)Marshal.SizeOf<ProcessEntry>() };
            if (Process32FirstW(snapshot, ref entry))
                do
                    parents[(int)entry.ProcessId] = (int)entry.ParentProcessId;
                while (Process32NextW(snapshot, ref entry));
        }
        finally
        {
            CloseHandle(snapshot);
        }
        return parents;
    }
}
