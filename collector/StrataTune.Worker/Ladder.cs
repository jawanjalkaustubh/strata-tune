using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Serialization;
using ComputeSharp;

namespace StrataTune.Worker;

internal enum LadderOutcome { Stable, Mismatch, DeviceLost, Interrupted }

/// <summary>The last stdout line of <c>--ladder</c>; member order is the wire order. Seconds
/// is what was asked for, elapsedMs what the pattern and the stream pass took. The bandwidth
/// fields are null unless the pattern ran to the end: the ladder stops at the first stage
/// that trips, and a stream pass on a card that just miscomputed proves nothing.</summary>
internal sealed record LadderResult(
    string Pattern,
    int Seconds,
    int Passes,
    int Mismatches,
    double? BandwidthGBs,
    long? BandwidthBufferBytes,
    int Dispatches,
    double ElapsedMs,
    [property: JsonIgnore] LadderOutcome Outcome)
{
    public string ToJson() => JsonSerializer.Serialize(this, LadderJson.Default.LadderResult);
}

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(LadderResult))]
internal sealed partial class LadderJson : JsonSerializerContext;

/// <summary>
/// One rung of the failure ladder (plan section 16), stages 1 and 2 from the worker's side.
/// The pattern runs for the requested seconds with the reference pass verified at its
/// cadence, and a run that stays stable ends with a 1 GiB stream pass whose bandwidth the
/// supervisor compares across memory steps (GDDR7 corrects silently and just gets slower;
/// the median is the number that repeats, the best-of is a tail sample). Stage 3, a TDR,
/// arrives here as device loss and stage 4 as no exit at all; both are the supervisor's to
/// act on, this process only reports what it saw before. The first mismatch ends the run.
/// </summary>
internal static class Ladder
{
    private const int BandwidthSeconds = 1;

    private static volatile bool interrupted;

    public static LadderResult Run(GraphicsDevice device, Pattern pattern, int seconds, ulong expect)
    {
        // Ctrl+C at a console ends the run at the next pass with its summary line rather than
        // with nothing. The supervisor's Kill needs no such courtesy: the process holds no
        // state outside itself, the driver drops its work and the heartbeat file is the
        // supervisor's own.
        Console.CancelKeyPress += (_, e) => { e.Cancel = true; interrupted = true; };

        long started = Stopwatch.GetTimestamp();
        long deadline = started + seconds * Stopwatch.Frequency;
        string name = Patterns.Name(pattern);
        int passes = 0;
        int mismatches = 0;
        int dispatches = 0;
        double? bandwidth = null;
        long? bufferBytes = null;
        LadderOutcome outcome = LadderOutcome.Stable;

        using ReferencePass reference = new(device);

        bool Check()
        {
            if (interrupted)
            {
                return false;
            }

            ulong hash = reference.Run();
            passes++;

            if (hash == expect)
            {
                return true;
            }

            mismatches++;
            Console.Error.WriteLine($"hash mismatch at pass {passes} of {name} after {Stopwatch.GetElapsedTime(started).TotalSeconds:F1} s: got {hash:x16}, expected {expect:x16}");
            return false;
        }

        try
        {
            dispatches = Patterns.Run(device, pattern, deadline, Check);

            if (mismatches > 0)
            {
                outcome = LadderOutcome.Mismatch;
            }
            else if (interrupted)
            {
                Console.Error.WriteLine($"interrupted after {passes} passes of {name}");
                outcome = LadderOutcome.Interrupted;
            }
            else
            {
                (long bytes, List<double> rates) = BenchRun.Bandwidth(device, BandwidthSeconds);
                bandwidth = Math.Round(rates[rates.Count / 2], 1);
                bufferBytes = bytes;
            }
        }
        catch (Exception e) when (DeviceLoss.Matches(e))
        {
            Console.Error.WriteLine($"device lost during {name} after {passes} passes: {e.Message}");
            outcome = LadderOutcome.DeviceLost;
        }

        return new LadderResult(
            name,
            seconds,
            passes,
            mismatches,
            bandwidth,
            bufferBytes,
            dispatches,
            Math.Round(Stopwatch.GetElapsedTime(started).TotalMilliseconds),
            outcome);
    }
}
