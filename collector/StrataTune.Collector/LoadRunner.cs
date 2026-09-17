using System.Diagnostics;
using System.Text.Json;
using StrataTune.Shared;

namespace StrataTune.Collector;

/// <summary>POST /load and GET /load/{id}: one worker at a time under the collector's watch,
/// with GPU 0 (the GPU kinds) or the CPU (the cpu kind) sampled at 2 Hz from just before it
/// starts until it exits, so the audit can judge the steady window (t ≥ 3 s) against the
/// start and the first sample is the idle reference. The worker is the one beside this exe
/// (<see cref="Serve"/> resolves it), inherits this process's token (plan section 5), and
/// its exit code is reported as is: 0 ok, 3 no hardware GPU, 10 device lost. The fillrate
/// kind starts the bench beside this exe instead (--fillrate --json), samples the GPU the
/// same way, and keeps the bench's result line, so the pixel rate and the SM clock it was
/// measured at travel together (the missing-ROPs cross-check, plan section 8). POST
/// /load/{id}/cancel (plan section 17c) kills the process and marks the run cancelled.</summary>
internal sealed class LoadRunner(Sources sources, string workerPath, string benchPath, Log log)
{
    public enum Start { Started, Busy, Rejected }
    public enum Cancel { Cancelled, NotRunning, NotFound }

    private const int MaxSeconds = 120;
    private const int KeepRuns = 8;
    private const int IdLength = 12;
    private static readonly TimeSpan SamplePeriod = TimeSpan.FromMilliseconds(500);
    // A worker that has not exited this long after its own deadline is stuck on the GPU.
    private static readonly TimeSpan Grace = TimeSpan.FromSeconds(20);
    // A cancel answers once the process is gone, or after this: the plan's "idle within 2 s".
    private static readonly TimeSpan CancelWait = TimeSpan.FromSeconds(2);

    private readonly Lock _gate = new();
    private readonly List<ActiveRun> _runs = [];

    private sealed class ActiveRun
    {
        public required string Id { get; init; }
        public required LoadKind Kind { get; init; }
        public required int Seconds { get; init; }
        public required long QpcStart { get; init; }
        public LoadRunState State { get; set; } = LoadRunState.Running;
        public int? ExitCode { get; set; }
        public long? QpcEnd { get; set; }
        public string? Error { get; set; }
        public Process? Process { get; set; }
        public List<GpuSample> Samples { get; } = [];
        public List<CpuSample> CpuSamples { get; } = [];
        public FillRateResult? FillRate { get; set; }

        public LoadRun Snapshot() => new(Id, Kind, Seconds, State, ExitCode, QpcStart, QpcEnd, Samples.ToList(), CpuSamples.ToList(), FillRate, Error);
    }

    public Start TryStart(LoadRunRequest request, out LoadRun? run, out string refusal)
    {
        run = null;
        if (request.Seconds is < 1 or > MaxSeconds)
        {
            refusal = $"seconds must be 1..{MaxSeconds}";
            return Start.Rejected;
        }
        var exe = Executable(request.Kind);
        if (!File.Exists(exe))
        {
            refusal = $"{Program(request.Kind)} not found: {exe}";
            return Start.Rejected;
        }

        lock (_gate)
        {
            if (_runs.LastOrDefault() is { State: LoadRunState.Running } current)
            {
                refusal = $"load run {current.Id} is still running";
                return Start.Busy;
            }

            var active = new ActiveRun
            {
                Id = Guid.NewGuid().ToString("N")[..IdLength],
                Kind = request.Kind,
                Seconds = request.Seconds,
                QpcStart = Stopwatch.GetTimestamp(),
            };
            _runs.Add(active);
            if (_runs.Count > KeepRuns)
                _runs.RemoveAt(0);
            _ = RunAsync(active);
            run = active.Snapshot();
            refusal = "";
            return Start.Started;
        }
    }

    public LoadRun? Get(string id)
    {
        lock (_gate)
            return _runs.FirstOrDefault(r => r.Id == id)?.Snapshot();
    }

    /// <summary>Stop (plan section 17c): the run is marked cancelled first, so a start that
    /// follows is not refused as busy, then the worker or bench is killed with its tree and
    /// waited for, bounded, so the answer means the GPU is free. <see cref="RunAsync"/> sees
    /// the exit and keeps the mark; a process not yet started when the mark lands is killed
    /// as it comes up.</summary>
    public Cancel TryCancel(string id, out LoadRun? run)
    {
        ActiveRun? active;
        Process? process;
        lock (_gate)
        {
            active = _runs.FirstOrDefault(r => r.Id == id);
            if (active is null)
            {
                run = null;
                return Cancel.NotFound;
            }
            if (active.State != LoadRunState.Running)
            {
                run = active.Snapshot();
                return Cancel.NotRunning;
            }
            active.State = LoadRunState.Cancelled;
            active.QpcEnd = Stopwatch.GetTimestamp();
            process = active.Process;
        }
        Kill(process);
        try
        {
            process?.WaitForExit(CancelWait);
        }
        catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
        }
        log.Write($"load {id}: cancelled");
        lock (_gate)
            run = active.Snapshot();
        return Cancel.Cancelled;
    }

    /// <summary>Kills a worker still running when the service stops, so no elevated GPU load
    /// outlives the UI.</summary>
    public void Abort()
    {
        lock (_gate)
        {
            foreach (var run in _runs.Where(r => r.State == LoadRunState.Running))
                Kill(run.Process);
        }
    }

    private static void Kill(Process? process)
    {
        try
        {
            process?.Kill(entireProcessTree: true);
        }
        catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
        }
    }

    private string Executable(LoadKind kind) => kind == LoadKind.FillRate ? benchPath : workerPath;

    private static string Program(LoadKind kind) => kind == LoadKind.FillRate ? "bench" : "worker";

    private async Task RunAsync(ActiveRun run)
    {
        var heartbeat = Path.Combine(Path.GetTempPath(), $"strata-tune-load-{run.Id}.heartbeat");
        var kind = run.Kind switch { LoadKind.Light => "light", LoadKind.Heavy => "heavy", LoadKind.FillRate => "fillrate", _ => "cpu" };
        var exe = Executable(run.Kind);
        var info = new ProcessStartInfo(exe)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        switch (run.Kind)
        {
            case LoadKind.Cpu:
                info.ArgumentList.Add("--cpu-load");
                break;
            case LoadKind.FillRate:
                info.ArgumentList.Add("--fillrate");
                info.ArgumentList.Add("--json");
                break;
            default:
                info.ArgumentList.Add("--load");
                info.ArgumentList.Add(kind);
                break;
        }
        info.ArgumentList.Add("--seconds");
        info.ArgumentList.Add(run.Seconds.ToString());
        // The bench has no heartbeat flag: its window and the deadline below are its liveness.
        if (run.Kind != LoadKind.FillRate)
        {
            info.ArgumentList.Add("--heartbeat");
            info.ArgumentList.Add(heartbeat);
        }
        log.Write($"load {run.Id}: {kind} for {run.Seconds} s, {Program(run.Kind)} {exe}");
        // Plan section 17c: a two-minute load or bench must not be cut by the sleep timer; released on every way out below.
        KeepAwake.Hold($"load {run.Id}");

        try
        {
            // Sampled before the worker exists, so the first sample is what idle looks like.
            Sample(run);
            using var process = Process.Start(info) ?? throw new InvalidOperationException("the worker did not start");
            lock (_gate)
            {
                run.Process = process;
                // Stopped between the idle sample and the start: the mark is already on the run.
                if (run.State == LoadRunState.Cancelled)
                    Kill(process);
            }
            // Both pipes are drained so a chatty worker can never block on a full pipe.
            var stdout = process.StandardOutput.ReadToEndAsync();
            var stderr = process.StandardError.ReadToEndAsync();
            var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(run.Seconds) + Grace;

            using var timer = new PeriodicTimer(SamplePeriod);
            while (!process.HasExited)
            {
                Sample(run);
                if (DateTime.UtcNow > deadline)
                {
                    process.Kill(entireProcessTree: true);
                    throw new TimeoutException($"the worker did not exit within {run.Seconds} s plus {Grace.TotalSeconds:0} s grace");
                }
                await timer.WaitForNextTickAsync();
            }

            await process.WaitForExitAsync();
            var output = await stdout;
            var error = (await stderr).Trim();
            // The bench promises exactly one JSON line on stdout; a run that ended 0 without
            // it has nothing to pair with the clock samples and is a failure, not a done run.
            var fillRate = run.Kind == LoadKind.FillRate && process.ExitCode == 0 ? ParseFillRate(output) : null;
            var ok = process.ExitCode == 0 && (run.Kind != LoadKind.FillRate || fillRate is not null);
            lock (_gate)
            {
                run.ExitCode = process.ExitCode;
                // A cancelled run keeps its mark: the kill's exit code is not a failure of the worker.
                if (run.State != LoadRunState.Cancelled)
                {
                    run.QpcEnd = Stopwatch.GetTimestamp();
                    run.State = ok ? LoadRunState.Done : LoadRunState.Failed;
                    run.FillRate = fillRate;
                    run.Error = ok ? null
                        : process.ExitCode == 0 ? "the bench exited 0 without its result line"
                        : $"{Program(run.Kind)} exited {process.ExitCode}: {error}";
                }
            }
            var count = run.Kind == LoadKind.Cpu ? $"{run.CpuSamples.Count} CPU samples" : $"{run.Samples.Count} GPU samples";
            log.Write($"load {run.Id}: exit {process.ExitCode}, {count}{(error.Length > 0 ? $", stderr: {error}" : "")}");
        }
        catch (Exception e)
        {
            lock (_gate)
            {
                if (run.State != LoadRunState.Cancelled)
                {
                    run.State = LoadRunState.Failed;
                    run.QpcEnd = Stopwatch.GetTimestamp();
                    run.Error = e.Message;
                }
            }
            log.Write($"load {run.Id}: failed: {e.Message}");
        }
        finally
        {
            KeepAwake.Release($"load {run.Id}");
            lock (_gate)
                run.Process = null;
            // The bench takes the family's gpu.lock in its own process and a kill skips its
            // release, so the lock would sit there under a dead pid; HeldBy clears exactly that.
            if (run.Kind == LoadKind.FillRate)
                FamilyGpuLock.HeldBy();
            try
            {
                File.Delete(heartbeat);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
            }
        }
    }

    private static FillRateResult? ParseFillRate(string stdout)
    {
        foreach (var line in stdout.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Reverse())
        {
            if (!line.StartsWith('{'))
                continue;
            try
            {
                return JsonSerializer.Deserialize(line, WireJson.Default.FillRateResult);
            }
            catch (JsonException)
            {
                return null;
            }
        }
        return null;
    }

    private void Sample(ActiveRun run)
    {
        if (run.Kind == LoadKind.Cpu)
        {
            // The library's last 2 Hz reading (at most half a second old, restamped to now so
            // the run's timeline is its own); a CPU group not yet open gives nulls, not zeros.
            var cpu = (sources.Lhm?.LatestCpu ?? new CpuSample(0, null, null, null, null)) with { Qpc = Stopwatch.GetTimestamp() };
            lock (_gate)
                run.CpuSamples.Add(cpu);
            return;
        }
        if (sources.Nvml is not { } nvml)
            return;
        try
        {
            var qpc = Stopwatch.GetTimestamp();
            if (nvml.Read().FirstOrDefault() is not { } g)
                return;
            lock (_gate)
                run.Samples.Add(new GpuSample(
                    qpc, g.Clocks.SmMhz, g.Clocks.MemMhz, g.PowerMw, g.TemperatureC,
                    g.ClocksEventReasons.Raw, g.Pcie.CurrentGen, g.Pcie.CurrentWidth));
        }
        catch (InvalidOperationException e)
        {
            log.Write($"load {run.Id}: NVML sample failed: {e.Message}");
        }
    }
}
