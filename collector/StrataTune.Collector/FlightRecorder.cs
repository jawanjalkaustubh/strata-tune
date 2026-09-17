using System.Text;
using System.Text.Json;
using StrataTune.Shared;

namespace StrataTune.Collector;

/// <summary>Plan section 16's flight recorder: while a tune run is on, the last 30 s of
/// the GPU timeline (the NVML facts, the CPU package, the GPU sensors the library reads,
/// and the ladder's own events) sit in memory and go to
/// %ProgramData%\Strata Tune\flight\current.ndjson once a second through a temp file and a
/// rename, so a hard hang leaves a whole file. A start that finds a crash keeps that file
/// as last-crash.ndjson for GET /tune/flight: what temps, clocks, power and limit bits were
/// doing in the seconds before the card died. One JSON object per line; a sample line is
/// {"kind":"sample",…}, an event line {"kind":"event",…}.</summary>
internal sealed class FlightRecorder
{
    public static readonly string Folder = Path.Combine(TuneStateStore.Root, "flight");
    public static readonly string CurrentPath = Path.Combine(Folder, "current.ndjson");
    public static readonly string LastCrashPath = Path.Combine(Folder, "last-crash.ndjson");

    private const int WindowSeconds = 30;
    private const int KeepEvents = 40;
    private static readonly TimeSpan FlushGap = TimeSpan.FromSeconds(1);
    // The library's GPU node and NVML: the sensors that explain a GPU crash. The whole row
    // would be 380 sensors a line on the dev box, written every second during a test.
    private static readonly string[] SensorPrefixes = ["/nvml/", "/gpu-"];

    private readonly Lock _gate = new();
    private readonly Queue<(DateTimeOffset At, string Line)> _samples = new();
    private readonly Queue<(DateTimeOffset At, string Line)> _events = new();
    private readonly Action<string> _log;
    private DateTimeOffset _lastFlush = DateTimeOffset.MinValue;
    private bool _active;

    public FlightRecorder(Action<string> log) => _log = log;

    /// <summary>A crash was found at start: the file the last run was writing is the evidence.</summary>
    public static void KeepLastCrash(Action<string> log)
    {
        try
        {
            if (!File.Exists(CurrentPath))
                return;
            File.Move(CurrentPath, LastCrashPath, overwrite: true);
            log($"tune: flight file of the crashed run kept as {LastCrashPath}");
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            log($"tune: could not keep the flight file: {e.Message}");
        }
    }

    public static bool HasLastCrash => File.Exists(LastCrashPath);

    public static string? ReadLastCrash()
    {
        try
        {
            return File.Exists(LastCrashPath) ? File.ReadAllText(LastCrashPath) : null;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    public void Start()
    {
        lock (_gate)
        {
            _samples.Clear();
            _events.Clear();
            _active = true;
        }
    }

    /// <summary>The run is over and the card is back at its baseline: nothing in the file is
    /// evidence of anything any more, so it goes, and a later start cannot mistake it for
    /// a crash's. Unless the baseline could not be put back: then the candidate may still be
    /// on the card, the file stays PENDING, and the seconds before are worth keeping for the
    /// start that reverts it.</summary>
    public void Stop(bool keepFile = false)
    {
        lock (_gate)
            _active = false;
        if (keepFile)
            return;
        try
        {
            File.Delete(CurrentPath);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
        }
    }

    public void Sample(long qpc, GpuFacts? gpu, CpuSample? cpu, SensorRow row)
    {
        var now = DateTimeOffset.UtcNow;
        var sensors = new Dictionary<string, float>();
        foreach (var (id, value) in row.Values)
            if (SensorPrefixes.Any(id.StartsWith))
                sensors[id] = MathF.Round(value, 3);
        var line = JsonSerializer.Serialize(new FlightSample("sample", now.ToString("O"), qpc, gpu, cpu, sensors), FlightJson.Default.FlightSample);
        lock (_gate)
        {
            if (!_active)
                return;
            _samples.Enqueue((now, line));
            while (_samples.Count > 0 && now - _samples.Peek().At > TimeSpan.FromSeconds(WindowSeconds))
                _samples.Dequeue();
            if (now - _lastFlush >= FlushGap)
            {
                _lastFlush = now;
                Flush();
            }
        }
    }

    public void Event(string text, TuneDeltas? candidate, int? stage, TunePattern? pattern)
    {
        var now = DateTimeOffset.UtcNow;
        var line = JsonSerializer.Serialize(new FlightEvent("event", now.ToString("O"), text, candidate, stage, pattern), FlightJson.Default.FlightEvent);
        lock (_gate)
        {
            if (!_active)
                return;
            _events.Enqueue((now, line));
            while (_events.Count > KeepEvents)
                _events.Dequeue();
            // An event is worth a write of its own: the apply that precedes a hang is the line that matters most.
            Flush();
        }
    }

    // Under the gate. Samples and events are merged by time so the file reads as one timeline.
    private void Flush()
    {
        var text = new StringBuilder();
        foreach (var (_, line) in _samples.Concat(_events).OrderBy(e => e.At))
            text.Append(line).Append('\n');
        try
        {
            Directory.CreateDirectory(Folder);
            var temp = $"{CurrentPath}.{Environment.ProcessId}.tmp";
            File.WriteAllText(temp, text.ToString(), new UTF8Encoding(false));
            File.Move(temp, CurrentPath, overwrite: true);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            _log($"tune: flight file not written: {e.Message}");
        }
    }
}

internal sealed record FlightSample(string Kind, string At, long Qpc, GpuFacts? Gpu, CpuSample? Cpu, Dictionary<string, float> Sensors);

internal sealed record FlightEvent(string Kind, string At, string Text, TuneDeltas? Candidate, int? Stage, TunePattern? Pattern);

[System.Text.Json.Serialization.JsonSourceGenerationOptions(PropertyNamingPolicy = System.Text.Json.Serialization.JsonKnownNamingPolicy.CamelCase, UseStringEnumConverter = true)]
[System.Text.Json.Serialization.JsonSerializable(typeof(FlightSample))]
[System.Text.Json.Serialization.JsonSerializable(typeof(FlightEvent))]
internal sealed partial class FlightJson : System.Text.Json.Serialization.JsonSerializerContext;
