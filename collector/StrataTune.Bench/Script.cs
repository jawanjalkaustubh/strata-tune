namespace StrataTune.Bench;

/// <summary>The fixed script of plan section 11a: five segments whose lengths are the only
/// difference between the 90 s run and the 15 s smoke run. Everything a segment does is timed
/// from the run's start, never from frame counts, so the script plays the same on any card.</summary>
internal sealed class Script
{
    public static readonly string[] Names = ["warm-up", "shader-compile", "texture-stream", "cpu-stall", "gpu-load"];

    public const int WarmUp = 0, ShaderCompile = 1, TextureStream = 2, CpuStall = 3, GpuLoad = 4;
    public const int Bursts = 5;
    public const int PeakPipelineStatesPerSecond = 8;
    public const double SpinMs = 30;
    public const double GpuTargetMs = 10;
    public const double GpuDuty = 0.9;

    private readonly double[] starts = new double[Names.Length];
    private readonly double[] durations;

    public string Kind { get; }
    public double SpinInterval { get; }
    public double Total { get; }

    private Script(string kind, double[] durations, double spinInterval)
    {
        Kind = kind;
        this.durations = durations;
        SpinInterval = spinInterval;
        for (int i = 1; i < Names.Length; i++)
        {
            starts[i] = starts[i - 1] + durations[i - 1];
        }
        Total = starts[^1] + durations[^1];
    }

    public static Script For(string kind) =>
        kind == "short" ? new Script(kind, [2, 4, 3, 3, 3], 1.0) : new Script(kind, [10, 20, 15, 15, 30], 2.0);

    public double Start(int segment) => starts[segment];

    public double End(int segment) => starts[segment] + durations[segment];

    public int SegmentAt(double seconds)
    {
        int segment = Names.Length - 1;
        while (segment > 0 && seconds < starts[segment])
        {
            segment--;
        }
        return segment;
    }

    /// <summary>One batch per second of the shader-compile segment, front-loaded like a game
    /// entering a new area: eight new states in the first second, tailing off to one.</summary>
    public int PipelineStateBatches => (int)durations[ShaderCompile];

    public int PipelineStateBatchSize(int batch) =>
        Math.Max(1, (int)Math.Round(PeakPipelineStatesPerSecond * (1 - batch / (double)PipelineStateBatches)));

    public int PipelineStateTotal => Enumerable.Range(0, PipelineStateBatches).Sum(PipelineStateBatchSize);

    public double BurstInterval => durations[TextureStream] / Bursts;
}
