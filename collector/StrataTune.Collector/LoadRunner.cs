using System.Diagnostics;
using StrataTune.Shared;

namespace StrataTune.Collector;

/// <summary>POST /load and GET /load/{id}: one worker at a time under the collector's watch,
/// with GPU 0 sampled at 2 Hz from the moment it starts until it exits, so the audit's
/// thermal-headroom check can judge the steady window (t ≥ 3 s) against the start. The
/// worker is the one beside this exe (<see cref="Serve"/> resolves it), inherits this
/// process's token (plan section 5), and its exit code is reported as is: 0 ok, 3 no
/// hardware GPU, 10 device lost.</summary>
internal sealed class LoadRunner(Nvml.Session? nvml, string workerPath, Log log)
{
    public enum Start { Started, Busy, Rejected }

    private const int MaxSeconds = 120;
    private const int KeepRuns = 8;
    private const int IdLength = 12;
    private static readonly TimeSpan SamplePeriod = TimeSpan.FromMilliseconds(500);
    // A worker that has not exited this long after its own deadline is stuck on the GPU.
    private static readonly TimeSpan Grace = TimeSpan.FromSeconds(20);

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

        public LoadRun Snapshot() => new(Id, Kind, Seconds, State, ExitCode, QpcStart, QpcEnd, Samples.ToList(), Error);
    }

    public Start TryStart(LoadRunRequest request, out LoadRun? run, out string refusal)
    {
        run = null;
        if (request.Seconds is < 1 or > MaxSeconds)
        {
            refusal = $"seconds must be 1..{MaxSeconds}";
            return Start.Rejected;
        }
        if (!File.Exists(workerPath))
        {
            refusal = $"worker not found: {workerPath}";
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

    /// <summary>Kills a worker still running when the service stops, so no elevated GPU load
    /// outlives the UI.</summary>
    public void Abort()
    {
        lock (_gate)
        {
            foreach (var run in _runs.Where(r => r.State == LoadRunState.Running))
            {
                try
                {
                    run.Process?.Kill(entireProcessTree: true);
                }
                catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception)
                {
                }
            }
        }
    }

    private async Task RunAsync(ActiveRun run)
    {
        var heartbeat = Path.Combine(Path.GetTempPath(), $"strata-tune-load-{run.Id}.heartbeat");
        var kind = run.Kind == LoadKind.Light ? "light" : "heavy";
        var info = new ProcessStartInfo(workerPath)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        info.ArgumentList.Add("--load");
        info.ArgumentList.Add(kind);
        info.ArgumentList.Add("--seconds");
        info.ArgumentList.Add(run.Seconds.ToString());
        info.ArgumentList.Add("--heartbeat");
        info.ArgumentList.Add(heartbeat);
        log.Write($"load {run.Id}: {kind} for {run.Seconds} s, worker {workerPath}");

        try
        {
            using var process = Process.Start(info) ?? throw new InvalidOperationException("the worker did not start");
            lock (_gate)
                run.Process = process;
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
            await stdout;
            var error = (await stderr).Trim();
            lock (_gate)
            {
                run.ExitCode = process.ExitCode;
                run.QpcEnd = Stopwatch.GetTimestamp();
                run.State = process.ExitCode == 0 ? LoadRunState.Done : LoadRunState.Failed;
                run.Error = process.ExitCode == 0 ? null : $"worker exited {process.ExitCode}: {error}";
            }
            log.Write($"load {run.Id}: exit {process.ExitCode}, {run.Samples.Count} GPU samples{(error.Length > 0 ? $", stderr: {error}" : "")}");
        }
        catch (Exception e)
        {
            lock (_gate)
            {
                run.State = LoadRunState.Failed;
                run.QpcEnd = Stopwatch.GetTimestamp();
                run.Error = e.Message;
            }
            log.Write($"load {run.Id}: failed: {e.Message}");
        }
        finally
        {
            lock (_gate)
                run.Process = null;
            try
            {
                File.Delete(heartbeat);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
            }
        }
    }

    private void Sample(ActiveRun run)
    {
        if (nvml is null)
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
