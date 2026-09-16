using System.Diagnostics;
using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using StrataTune.Shared;

namespace StrataTune.Collector;

/// <summary>The --serve verb: the UI's mode. Refuses to run non-elevated (exit 2) because
/// the alternative is serving zeros; binds Kestrel to a dynamic loopback port; writes the
/// handshake; samples until the parent is gone, Ctrl+C or SIGTERM; then removes the
/// handshake and exits 0, within a few seconds whatever a driver is doing.</summary>
internal static class Serve
{
    private const int ExitOk = 0, ExitFailure = 1, ExitNotElevated = 2;
    private const int TokenBytes = 32;
    private const string WorkerExe = "strata-tune-worker.exe";
    private static readonly TimeSpan LoopDrain = TimeSpan.FromSeconds(2);
    // The no-orphan rule gives the process 5 s after the UI is gone; a stuck ioctl inside a
    // sampler's Dispose must not spend them.
    private static readonly TimeSpan ShutdownDeadline = TimeSpan.FromSeconds(4);
    // performance.timeOrigin in the UI is a few hundred milliseconds after CreateProcess; a pid
    // handed to a new process meanwhile is off by far more than this.
    private static readonly TimeSpan ParentStartTolerance = TimeSpan.FromSeconds(10);

    public static int Run(string[] args)
    {
        int? parentPid = null;
        long? parentStartMs = null;
        string? worker = null, handshake = null, logPath = null;
        for (var i = 1; i < args.Length; i++)
        {
            var value = i + 1 < args.Length ? args[i + 1] : null;
            switch (args[i])
            {
                // --ui-pid is the lifecycle audit's spelling of the same argument (item 32).
                case "--parent-pid" or "--ui-pid" when int.TryParse(value, out var pid) && pid > 0:
                    parentPid = pid;
                    i++;
                    break;
                case "--parent-start" when long.TryParse(value, out var ms) && ms > 0:
                    parentStartMs = ms;
                    i++;
                    break;
                case "--worker" when value is not null:
                    worker = value;
                    i++;
                    break;
                case "--handshake" when value is not null:
                    handshake = value;
                    i++;
                    break;
                case "--log" when value is not null:
                    logPath = value;
                    i++;
                    break;
                default:
                    Console.Error.WriteLine($"--serve: bad or missing value for {args[i]}");
                    return ExitFailure;
            }
        }

        if (parentPid is null)
        {
            Console.Error.WriteLine("--serve needs --parent-pid <pid>");
            return ExitFailure;
        }

        if (!Lhm.IsElevated)
        {
            Console.Error.WriteLine("not elevated: the sensor drivers only answer administrators and this service will not serve zeros");
            return ExitNotElevated;
        }

        // A UAC prompt answered after its UI has gone (or a stale prompt from an earlier start)
        // must not open the sensors and bind this process to whatever now holds the pid.
        if (!ParentWatch.IsRunning(parentPid.Value))
        {
            Console.Error.WriteLine($"--parent-pid {parentPid}: no such process, nothing to serve");
            return ExitFailure;
        }
        if (parentStartMs is { } startMs && !ParentWatch.StartedAround(parentPid.Value, startMs, ParentStartTolerance))
        {
            Console.Error.WriteLine($"--parent-pid {parentPid} did not start at --parent-start {startMs}: the pid has been reused, nothing to serve");
            return ExitFailure;
        }

        // This process runs as administrator: the only worker it will start is the one
        // installed beside it, never a path handed in from medium integrity.
        var workerPath = ResolveWorker(worker);
        if (workerPath is null)
        {
            Console.Error.WriteLine($"--worker must name {WorkerExe} inside {AppContext.BaseDirectory}");
            return ExitFailure;
        }

        AppPaths.Configure(handshake, logPath);
        if (HandshakeFile.LiveCollectorPid() is { } live)
        {
            Console.Error.WriteLine($"a collector (pid {live}) is already running for this user; a live collector is never doubled");
            return ExitFailure;
        }

        var log = new Log(AppPaths.Log);
        try
        {
            return RunAsync(parentPid.Value, workerPath, log).GetAwaiter().GetResult();
        }
        catch (Exception e)
        {
            log.Write($"fatal: {e}");
            Console.Error.WriteLine(e.Message);
            HandshakeFile.Delete();
            return ExitFailure;
        }
    }

    private static string? ResolveWorker(string? requested)
    {
        var baseDir = Path.TrimEndingDirectorySeparator(Path.GetFullPath(AppContext.BaseDirectory)) + Path.DirectorySeparatorChar;
        var path = Path.GetFullPath(requested ?? Path.Combine(baseDir, WorkerExe));
        return path.StartsWith(baseDir, StringComparison.OrdinalIgnoreCase) ? path : null;
    }

    private static async Task<int> RunAsync(int parentPid, string workerPath, Log log)
    {
        var version = typeof(Serve).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "0";
        var startedAt = DateTimeOffset.UtcNow.ToString("O");
        var startedQpc = Stopwatch.GetTimestamp();
        log.Write($"start pid {Environment.ProcessId} version {version} parent {parentPid}");

        var pawnIo = PawnIoDevice.Check();
        if (!pawnIo.Usable)
            log.Write($"PawnIO unusable, CPU and board sensors disabled: {pawnIo.Detail}");

        // Each source opens on its own: one that cannot (no NVIDIA driver, a corrupt
        // performance-counter registry, a library that throws on this board) is a gap
        // reported in /health, not a collector that never answers.
        var buffer = new RingBuffer();
        Lhm.ReportNodeFailure = log.Write;
        var nvml = Open("NVML", () => Nvml.Open(), log);
        var lhm = Open("LibreHardwareMonitor", () => new LhmSampler(pawnIo.Usable, buffer), log);
        var pdh = Open("PDH", () => new PdhSampler(buffer, log), log);
        var nvmlSampler = nvml is null ? null : new NvmlSampler(nvml, buffer);
        var loads = new LoadRunner(nvml, workerPath, log);

        var builder = WebApplication.CreateSlimBuilder(new WebApplicationOptions { ContentRootPath = AppContext.BaseDirectory });
        builder.Logging.ClearProviders();
        builder.WebHost.ConfigureKestrel(kestrel => kestrel.Listen(IPAddress.Loopback, 0));
        builder.Services.ConfigureHttpJsonOptions(o => o.SerializerOptions.TypeInfoResolverChain.Insert(0, WireJson.Default));
        var app = builder.Build();

        var state = new CollectorState
        {
            Log = log,
            Buffer = buffer,
            Nvml = nvml,
            NvmlSampler = nvmlSampler,
            Lhm = lhm,
            Pdh = pdh,
            Loads = loads,
            PawnIoUsable = pawnIo.Usable,
            Version = version,
            StartedAt = startedAt,
            StartedQpc = startedQpc,
            Stopping = app.Lifetime.ApplicationStopping,
        };
        var token = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(TokenBytes));
        app.UseBearerToken(token);
        Endpoints.Map(app, state);
        // Graceful stop from the UI's before-quit (lifecycle audit item 32); the parent
        // watch below is what ends this process on every other exit path.
        ShutdownRoute.Map(app, () =>
        {
            log.Write("POST /shutdown from the UI, stopping");
            app.Lifetime.StopApplication();
        });

        await app.StartAsync();
        var port = new Uri(app.Urls.First()).Port;
        HandshakeFile.Write(new Handshake(port, token, Environment.ProcessId, startedAt));
        log.Write($"listening on 127.0.0.1:{port}, handshake written");

        var stopping = app.Lifetime.ApplicationStopping;
        var loops = new List<Task>();
        if (lhm is not null)
            loops.Add(lhm.RunAsync(log, stopping));
        if (pdh is not null)
            loops.Add(pdh.RunAsync(log, stopping));
        if (nvmlSampler is not null)
            loops.Add(nvmlSampler.RunAsync(log, stopping));
        _ = WatchParentAsync();

        await app.WaitForShutdownAsync();
        log.Write("stopping: sampling halted");
        loads.Abort();
        HandshakeFile.Delete();
        // From here the OS reclaims everything anyway; closing the sensor tree is a courtesy
        // that must not outlive the deadline if a driver call has hung inside a sampler.
        _ = Task.Delay(ShutdownDeadline).ContinueWith(_ =>
        {
            log.Write("exit 0 (a sampler did not stop in time; leaving it to the OS)");
            Environment.Exit(ExitOk);
        });
        await Task.WhenAny(Task.WhenAll(loops), Task.Delay(LoopDrain));
        lhm?.Dispose();
        pdh?.Dispose();
        nvml?.Dispose();
        log.Write("exit 0");
        return ExitOk;

        // The watch also returns when we are stopping for another reason; only a parent that
        // really went away is worth a log line and a stop.
        async Task WatchParentAsync()
        {
            await ParentWatch.WaitForExitAsync(parentPid, stopping);
            if (stopping.IsCancellationRequested)
                return;
            log.Write($"parent {parentPid} gone, stopping");
            app.Lifetime.StopApplication();
        }
    }

    private static T? Open<T>(string source, Func<T> open, Log log) where T : class
    {
        try
        {
            return open();
        }
        catch (Exception e)
        {
            log.Write($"{source} unavailable, started without it: {e.GetType().Name}: {e.Message}");
            return null;
        }
    }
}
