using System.Runtime.Versioning;

// DirectX 12 only exists on Windows 8+; saying so keeps the platform analyzer quiet on every Vortice call.
[assembly: SupportedOSPlatform("windows6.2")]

namespace StrataTune.Bench;

// Exit codes, shared with the app's Phase 5 integrate step:
//   0  ok                                   3  no DX12 hardware adapter (WARP is refused)
//   1  bad arguments or unexpected failure  10 device removed (TDR)
//   2  interrupted: Ctrl+C, Esc or the window closed before the script ended
//                                           11 gpu.lock held by another Strata app
internal static class Program
{
    private const int ExitOk = 0;
    private const int ExitFailure = 1;
    private const int ExitInterrupted = 2;
    private const int ExitNoHardwareGpu = 3;
    private const int ExitDeviceLost = 10;
    private const int ExitLockHeld = 11;

    private const string Usage = """
        usage:
          strata-tune-bench [--script full|short] [--vsync] [--vram-target PERCENT] [--fps-cap N]
                            [--width W] [--height H] [--adapter LUID] [--json] [--debug]
          strata-tune-bench --fillrate [--seconds N] [--width W] [--height H] [--adapter LUID] [--json] [--debug]
        --script short plays the 15 s smoke version of the 90 s script.
        --vram-target is the share of the adapter's dedicated memory the texture-stream segment fills (default 40).
        --fps-cap 0 removes the 120 fps pacing outside the gpu-load segment.
        --fillrate measures pixels written per second (full-screen quads, no blend, no depth) for --seconds (default 6) after a 1 s warm-up.
        --adapter takes a luid from strata-tune-worker --devices; without it the DXGI high-performance adapter is used.
        """;

    private static volatile bool cancelled;

    private static int Main(string[] args)
    {
        Options options;
        try
        {
            options = Options.Parse(args);
        }
        catch (ArgumentException e)
        {
            Console.Error.WriteLine(e.Message);
            Console.Error.WriteLine(Usage);
            return ExitFailure;
        }

        if (GpuLock.HeldBy() is string holder)
        {
            Console.Error.WriteLine(holder);
            return ExitLockHeld;
        }

        GpuLock.Take();
        Console.CancelKeyPress += (_, e) =>
        {
            e.Cancel = true;
            cancelled = true;
        };

        // A caught failure keeps the exit code meaningful and keeps Windows Error Reporting from
        // parking a dialog on a process the app is waiting on; the lock goes whatever happened.
        try
        {
            return Run(options);
        }
        catch (NoHardwareAdapterException e)
        {
            Console.Error.WriteLine(e.Message);
            return ExitNoHardwareGpu;
        }
        catch (Exception e)
        {
            Console.Error.WriteLine(e);
            return ExitFailure;
        }
        finally
        {
            GpuLock.Release();
        }
    }

    private static int Run(Options options)
    {
        using Pacing.TimerResolution resolution = new();
        using Window window = new(options.FillRate ? "Strata Tune bench: fill rate" : "Strata Tune bench", options.Width, options.Height);
        using Gpu gpu = new(window.Handle, options.Width, options.Height, options.Adapter, options.Debug);
        if (options.FillRate)
        {
            return RunFillRate(options, window, gpu);
        }

        Script script = Script.For(options.Script);
        using Scene scene = new(gpu.Device, options.Width, options.Height, script.PipelineStateTotal);
        using Streaming streaming = new(gpu.Device, gpu.DedicatedVideoMemory, options.VramTargetPercent, Script.Bursts);

        // --json promises one line on stdout and nothing else, so the device line stays off it.
        if (!options.Json)
        {
            Console.WriteLine($"device {gpu.Name} luid {gpu.Luid} hardware");
            Console.WriteLine($"textures {streaming.PerBurst} x {Streaming.TextureBytes >> 20} MiB per burst");
        }

        window.Show();
        Summary summary;
        try
        {
            summary = Bench.Run(options, script, window, gpu, scene, streaming, () => cancelled);
            gpu.WaitIdle();
        }
        catch (Exception e) when (gpu.IsDeviceRemoved(e))
        {
            Console.Error.WriteLine($"device removed: {gpu.DeviceRemovedReason}");
            return ExitDeviceLost;
        }

        if (options.Json)
        {
            Console.WriteLine(summary.ToJson());
        }
        else
        {
            foreach (string line in summary.Lines())
            {
                Console.WriteLine(line);
            }
        }

        return summary.Completed ? ExitOk : ExitInterrupted;
    }

    private static int RunFillRate(Options options, Window window, Gpu gpu)
    {
        using FillRate fill = new(gpu.Device);
        if (!options.Json)
        {
            Console.WriteLine($"device {gpu.Name} luid {gpu.Luid} hardware");
        }

        window.Show();
        FillRateSummary summary;
        try
        {
            summary = FillRate.Run(options.Seconds, window, gpu, fill, () => cancelled);
        }
        catch (Exception e) when (gpu.IsDeviceRemoved(e))
        {
            Console.Error.WriteLine($"device removed: {gpu.DeviceRemovedReason}");
            return ExitDeviceLost;
        }

        if (options.Json)
        {
            Console.WriteLine(summary.ToJson());
        }
        else
        {
            foreach (string line in summary.Lines())
            {
                Console.WriteLine(line);
            }
        }

        return summary.Completed ? ExitOk : ExitInterrupted;
    }
}
