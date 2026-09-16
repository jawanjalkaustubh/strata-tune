using System.Text.Json;
using System.Text.Json.Serialization;

namespace StrataTune.Bench;

internal sealed record SegmentSummary(string Name, double Start, double End, int Frames, double AvgFps, double MaxFrameMs, double AvgGpuMs);

/// <summary>The one JSON line of <c>--json</c>; member order is the wire order.</summary>
internal sealed record Summary(
    string Script,
    string Device,
    long Luid,
    int Pid,
    int Width,
    int Height,
    bool Vsync,
    int FpsCap,
    int VramTargetPercent,
    bool Completed,
    int Frames,
    double Seconds,
    SegmentSummary[] Segments,
    int PipelineStates,
    int TexturesUploaded,
    long UploadedMiB,
    uint HeavyIterations)
{
    public string ToJson() => JsonSerializer.Serialize(this, SummaryJson.Default.Summary);

    public IEnumerable<string> Lines()
    {
        yield return $"script {Script} {Seconds:F1} s, {Width}x{Height}, vsync {(Vsync ? "on" : "off")}, fps cap {FpsCap}, vram target {VramTargetPercent} %{(Completed ? "" : ", interrupted")}";
        foreach (SegmentSummary segment in Segments)
        {
            yield return $"segment {segment.Name} {segment.Start:F0}-{segment.End:F0} s: {segment.Frames} frames, {segment.AvgFps:F1} fps, max {segment.MaxFrameMs:F1} ms, gpu {segment.AvgGpuMs:F2} ms";
        }
        yield return $"pipeline states {PipelineStates}, textures {TexturesUploaded} ({UploadedMiB} MiB), heavy iterations {HeavyIterations}";
        yield return $"frames {Frames}";
    }
}

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(Summary))]
internal sealed partial class SummaryJson : JsonSerializerContext;
