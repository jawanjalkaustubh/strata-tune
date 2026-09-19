using System.Runtime.InteropServices;
using System.Text;

namespace StrataTune.Collector;

/// <summary>Who is really on the other end of a loopback socket (threat: the bearer token in
/// %LOCALAPPDATA%\Strata Tune\collector.json is readable by any process running as this same
/// user — the file is not, and cannot be, restricted to only the UI — so loopback-plus-token
/// is not proof the caller is our UI at all; any same-user malware that reads the file could
/// drive this elevated service: GPU clock writes, POST /shutdown. There is no socket handle
/// to ask "who owns you" directly, so this maps the accepted connection's remote (client)
/// port to its owning PID via the OS's TCP table, then resolves that PID's own image path,
/// so <see cref="Auth"/> can require the caller to actually be someone we trust to hold the
/// token, not merely someone who read it.</summary>
internal static class PeerProcess
{
    private const int AfInet = 2;
    private const int TcpTableOwnerPidAll = 5;
    private const int ErrorInsufficientBuffer = 122;
    private const int ProcessQueryLimitedInformation = 0x1000;

    [StructLayout(LayoutKind.Sequential)]
    private struct MibTcpRowOwnerPid
    {
        public uint State;
        public uint LocalAddr;
        public uint LocalPort;  // low WORD only, network byte order — see PortOf
        public uint RemoteAddr;
        public uint RemotePort; // unused here
        public uint OwningPid;
    }

    [DllImport("iphlpapi.dll", SetLastError = true)]
    private static extern uint GetExtendedTcpTable(IntPtr tcpTable, ref int size, [MarshalAs(UnmanagedType.Bool)] bool sort, int ipVersion, int tableClass, int reserved);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(int desiredAccess, [MarshalAs(UnmanagedType.Bool)] bool inheritHandle, int processId);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryFullProcessImageNameW(IntPtr process, int flags, StringBuilder exeName, ref int size);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    /// <summary>The process holding the loopback connection whose client-side (ephemeral)
    /// port Kestrel reports to us as <paramref name="remotePort"/>, and that process's own
    /// image path — or null when the TCP table no longer has a row for the port (the caller
    /// already disconnected) or Windows will not say (a protected process, which is never
    /// something we would trust anyway).</summary>
    public static (int Pid, string? ImagePath)? Resolve(int remotePort)
    {
        var pid = OwningPid(remotePort);
        return pid is null ? null : (pid.Value, ImagePathOf(pid.Value));
    }

    /// <summary>Whether the given peer is someone allowed to spend the bearer token: us (a
    /// self-call), the launcher that started this collector, anything that shares the
    /// launcher's own exe (Electron's renderer and utility processes are separate PIDs
    /// running the same electron.exe) or lives in the launcher's install directory, or one
    /// of our own worker/bench children (installed beside the collector itself, never
    /// elsewhere — see Serve.ResolveWorker). A peer whose image path could not be resolved
    /// is never trusted: the whole point is proving who is calling, and "unknown" is not it.</summary>
    public static bool IsTrusted(int peerPid, string? peerImagePath, PeerTrust trust)
    {
        if (peerPid == trust.OwnPid || peerPid == trust.LauncherPid)
            return true;
        if (peerImagePath is null)
            return false;
        if (trust.LauncherImagePath is not null)
        {
            if (string.Equals(peerImagePath, trust.LauncherImagePath, StringComparison.OrdinalIgnoreCase))
                return true;
            if (SameDirectory(peerImagePath, trust.LauncherImagePath))
                return true;
        }
        var peerDir = Path.GetDirectoryName(peerImagePath);
        return peerDir is not null && string.Equals(
            Path.TrimEndingDirectorySeparator(peerDir),
            Path.TrimEndingDirectorySeparator(trust.CollectorDir),
            StringComparison.OrdinalIgnoreCase);
    }

    private static bool SameDirectory(string a, string b)
    {
        var da = Path.GetDirectoryName(a);
        var db = Path.GetDirectoryName(b);
        return da is not null && db is not null && string.Equals(da, db, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>Resolves a PID's own executable path with PROCESS_QUERY_LIMITED_INFORMATION,
    /// the same access an elevated process can get on an unrelated same-user process without
    /// needing PROCESS_VM_READ — <see cref="System.Diagnostics.Process.MainModule"/> asks for
    /// more than that and can throw across an architecture (32/64-bit) mismatch. Null on any
    /// failure (the pid exited, or Windows refuses): treated as "cannot verify", never as trusted.</summary>
    public static string? ImagePathOf(int pid)
    {
        var handle = OpenProcess(ProcessQueryLimitedInformation, false, pid);
        if (handle == IntPtr.Zero)
            return null;
        try
        {
            var size = 1024;
            var name = new StringBuilder(size);
            return QueryFullProcessImageNameW(handle, 0, name, ref size) ? name.ToString(0, size) : null;
        }
        catch (ArgumentOutOfRangeException)
        {
            return null;
        }
        finally
        {
            CloseHandle(handle);
        }
    }

    // Ports in MIB_TCPROW_OWNER_PID are the low WORD of the DWORD, in network (big-endian)
    // byte order; on this little-endian architecture that reads back byte-swapped.
    private static ushort PortOf(uint raw) => (ushort)(((raw & 0xFF) << 8) | ((raw >> 8) & 0xFF));

    private static int? OwningPid(int port)
    {
        var size = 0;
        GetExtendedTcpTable(IntPtr.Zero, ref size, false, AfInet, TcpTableOwnerPidAll, 0);
        if (size <= 0)
            return null;
        // The table can grow between the sizing call and the real one (a connection opened
        // in between); a handful of retries covers that without looping forever.
        for (var attempt = 0; attempt < 3; attempt++)
        {
            var buffer = Marshal.AllocHGlobal(size);
            try
            {
                var result = GetExtendedTcpTable(buffer, ref size, false, AfInet, TcpTableOwnerPidAll, 0);
                if (result == ErrorInsufficientBuffer)
                    continue;
                if (result != 0)
                    return null;
                var rowCount = Marshal.ReadInt32(buffer);
                var rowSize = Marshal.SizeOf<MibTcpRowOwnerPid>();
                var rowsStart = buffer + sizeof(int);
                for (var i = 0; i < rowCount; i++)
                {
                    var row = Marshal.PtrToStructure<MibTcpRowOwnerPid>(rowsStart + i * rowSize);
                    // The connecting side's ephemeral port is ITS local port, which is what
                    // Kestrel hands back to us as the accepted connection's remote port.
                    if (PortOf(row.LocalPort) == port)
                        return (int)row.OwningPid;
                }
                return null;
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }
        return null;
    }
}

/// <summary>What <see cref="Auth"/> needs to judge a peer, recorded once at startup by
/// <see cref="Serve"/> (the launcher's identity never changes for this collector's life).
/// <see cref="TrustLocalPeers"/> is the development-only escape hatch (--trust-local-peers):
/// when set, <see cref="Auth"/> skips the peer check entirely and only the token and
/// loopback checks apply, same as before this file existed.</summary>
internal sealed record PeerTrust(int OwnPid, int LauncherPid, string? LauncherImagePath, string CollectorDir, bool TrustLocalPeers);
