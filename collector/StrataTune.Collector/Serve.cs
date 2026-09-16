using System.Diagnostics;
using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using StrataTune.Shared;

namespace StrataTune.Collector;

/// <summary>The --serve verb: the UI's mode. Refuses to run non-elevated (exit 2) because
/// the alternative is serving zeros; binds Kestrel to a dynamic loopback port; writes the
/// handshake; samples until the parent is gone, Ctrl+C or SIGTERM; then removes the
/// handshake and exits 0.</summary>
internal static class Serve
{
    private const int ExitOk = 0, ExitFailure = 1, ExitNotElevated = 2;
    private const int TokenBytes = 32;
    private static readonly TimeSpan LoopDrain = TimeSpan.FromSeconds(5);

    public static int Run(string[] args)
    {
        int? parentPid = null;
        string? worker = null;
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
                case "--worker" when value is not null:
                    worker = value;
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

        var log = new Log(AppPaths.Log);
        try
        {
            return RunAsync(parentPid.Value, worker, log).GetAwaiter().GetResult();
        }
        catch (Exception e)
        {
            log.Write($"fatal: {e}");
            Console.Error.WriteLine(e.Message);
            HandshakeFile.Delete();
            return ExitFailure;
        }
    }

    private static async Task<int> RunAsync(int parentPid, string? workerPath, Log log)
    {
        var version = typeof(Serve).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "0";
        var startedAt = DateTimeOffset.UtcNow.ToString("O");
        var startedQpc = Stopwatch.GetTimestamp();
        log.Write($"start pid {Environment.ProcessId} version {version} parent {parentPid}");

        var pawnIo = PawnIoDevice.Check();
        if (!pawnIo.Usable)
            log.Write($"PawnIO unusable, CPU and board sensors disabled: {pawnIo.Detail}");

        Nvml.Session? nvml = null;
        try
        {
            nvml = Nvml.Open();
        }
        catch (Exception e) when (e is DllNotFoundException or InvalidOperationException)
        {
            log.Write($"NVML unavailable: {e.Message}");
        }

        var buffer = new RingBuffer();
        using var lhm = new LhmSampler(pawnIo.Usable, buffer);
        using var pdh = new PdhSampler(buffer);
        var nvmlSampler = nvml is null ? null : new NvmlSampler(nvml, buffer);
        var loads = new LoadRunner(nvml, workerPath ?? Path.Combine(AppContext.BaseDirectory, "strata-tune-worker.exe"), log);

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
        var loops = new List<Task> { lhm.RunAsync(log, stopping), pdh.RunAsync(log, stopping) };
        if (nvmlSampler is not null)
            loops.Add(nvmlSampler.RunAsync(log, stopping));
        _ = WatchParentAsync();

        await app.WaitForShutdownAsync();
        log.Write("stopping: sampling halted");
        await Task.WhenAny(Task.WhenAll(loops), Task.Delay(LoopDrain));
        loads.Abort();
        HandshakeFile.Delete();
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
}
