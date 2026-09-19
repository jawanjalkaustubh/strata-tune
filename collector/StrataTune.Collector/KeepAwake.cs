using System.Runtime.InteropServices;

namespace StrataTune.Collector;

/// <summary>Plan section 17c, 'No sleeping mid-run': while a hunt, a load run or the bench is
/// active the collector holds <c>SetThreadExecutionState(ES_SYSTEM_REQUIRED | ES_CONTINUOUS)</c>
/// so the idle timer cannot sleep the machine under a 16-minute hunt and turn a suspended run
/// into a hang the flight recorder would have to explain. The display is never held
/// (ES_DISPLAY_REQUIRED is not set: a laptop lid or a dark screen mid-run is fine). The state
/// is per thread, so the calls run on one dedicated thread whatever thread pool thread a run
/// happens to be on; a count lets overlapping runs (a load run under a hunt is refused, but a
/// hunt's own launches nest) hold once and release on the last end, and every stop and abort
/// path releases through the same call.</summary>
internal static class KeepAwake
{
    private const uint EsContinuous = 0x80000000;
    private const uint EsSystemRequired = 0x00000001;

    [DllImport("kernel32.dll", EntryPoint = "SetThreadExecutionState")]
    private static extern uint SetExecutionState(uint flags);

    private static readonly Lock Gate = new();
    private static readonly HashSet<string> Holders = [];
    private static Thread? _thread;
    private static readonly AutoResetEvent Wake = new(false);
    private static volatile bool _wanted;

    /// <summary>Holds the system awake for the named run; the first holder starts the hold.</summary>
    public static void Hold(string holder)
    {
        lock (Gate)
        {
            Holders.Add(holder);
            Set(wanted: true);
        }
    }

    /// <summary>Releases the named run's hold; the system may sleep again once nobody holds it.</summary>
    public static void Release(string holder)
    {
        lock (Gate)
        {
            Holders.Remove(holder);
            Set(wanted: Holders.Count > 0);
        }
    }

    /// <summary>Whether a hold is in force now, for the log and the tests.</summary>
    public static bool Holding
    {
        get { lock (Gate) return Holders.Count > 0; }
    }

    // The flag belongs to the thread that set it, so one background thread owns it for the
    // process's life: it is asked to set or clear and does nothing else.
    private static void Set(bool wanted)
    {
        _wanted = wanted;
        if (_thread is null)
        {
            _thread = new Thread(Loop) { IsBackground = true, Name = "keep-awake" };
            _thread.Start();
        }
        Wake.Set();
    }

    private static void Loop()
    {
        var holding = false;
        while (true)
        {
            Wake.WaitOne();
            var wanted = _wanted;
            if (wanted == holding)
                continue;
            // ES_CONTINUOUS alone clears the requirement set by this thread.
            SetExecutionState(wanted ? EsContinuous | EsSystemRequired : EsContinuous);
            holding = wanted;
        }
    }
}
