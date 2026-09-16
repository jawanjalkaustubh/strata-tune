using System.Runtime.Versioning;
using ComputeSharp;

// DirectX 12 only exists on Windows 8+; saying so keeps the platform analyzer quiet on every ComputeSharp call.
[assembly: SupportedOSPlatform("windows6.2")]

namespace StrataTune.Worker;

// Exit codes, shared with the collector's tune supervisor:
//   0  ok                                   3  the selected adapter is WARP, not hardware
//   1  bad arguments or unexpected failure  10 device lost (TDR)
//   2  hash differs from --expect
internal static class Program
{
    private const int ExitOk = 0;
    private const int ExitFailure = 1;
    private const int ExitMismatch = 2;
    private const int ExitNoHardwareGpu = 3;
    private const int ExitDeviceLost = 10;

    private const string Usage = """
        usage:
          strata-tune-worker --devices
          strata-tune-worker --hash [--adapter LUID] [--elements N] [--rounds R] [--seed S] [--expect HEX] [--heartbeat PATH]
          strata-tune-worker --load light|heavy --seconds N [--adapter LUID] [--heartbeat PATH]
          strata-tune-worker --bench [--json] [--seconds N] [--adapter LUID] [--heartbeat PATH]
        --adapter takes a luid from --devices; without it the DXGI high-performance adapter is used.
        --elements is at most 536870912 (2 GiB of uint).
        """;

    private static volatile bool deviceLost;

    private static int Main(string[] args)
    {
        // A caught failure keeps the exit code meaningful and keeps Windows Error Reporting
        // from parking a dialog on a process the supervisor is waiting on.
        try
        {
            Options options = Options.Parse(args);

            return options.Verb switch
            {
                "--devices" => ListDevices(),
                "--load" => RunLoad(options),
                "--bench" => RunBench(options),
                _ => Hash(options),
            };
        }
        catch (Exception e) when (deviceLost || DeviceLoss.Matches(e))
        {
            Console.Error.WriteLine($"device lost: {e.Message}");
            return ExitDeviceLost;
        }
        catch (ArgumentException e)
        {
            Console.Error.WriteLine(e.Message);
            Console.Error.WriteLine(Usage);
            return ExitFailure;
        }
        catch (Exception e)
        {
            Console.Error.WriteLine(e);
            return ExitFailure;
        }
    }

    private static int ListDevices()
    {
        foreach (GraphicsDevice device in GraphicsDevice.EnumerateDevices())
        {
            using (device)
            {
                Console.WriteLine(
                    $"{device.Name} | luid {device.Luid} | {(device.IsHardwareAccelerated ? "hardware" : "software (WARP)")}"
                    + $" | {device.DedicatedMemorySize >> 20} MiB dedicated | {device.ComputeUnits} compute units | wavefront {device.WavefrontSize}");
            }
        }

        return ExitOk;
    }

    // GetDefault picks the DXGI high-performance adapter and falls back to WARP without
    // saying so, so a "passing" run on it may never have touched the card under test; the
    // supervisor passes the luid of the card it means and compares it with the device line.
    private static GraphicsDevice Select(string? luid)
    {
        if (luid is null)
        {
            return GraphicsDevice.GetDefault();
        }

        GraphicsDevice? match = null;

        foreach (GraphicsDevice device in GraphicsDevice.EnumerateDevices())
        {
            if (match is null && device.Luid.ToString() == luid)
            {
                match = device;
            }
            else
            {
                device.Dispose();
            }
        }

        return match ?? throw new ArgumentException($"--adapter: no device with luid {luid}; run --devices");
    }

    /// <summary>The device every verb runs on, or null with exit 3 already explained: a
    /// software rasteriser is refused rather than reported as a GPU result.</summary>
    private static GraphicsDevice? HardwareDevice(string? luid, bool announce = true)
    {
        GraphicsDevice device = Select(luid);

        if (!device.IsHardwareAccelerated)
        {
            Console.Error.WriteLine($"no DX12 SM6 hardware adapter was selected: {device.Name} is a software rasteriser");
            return null;
        }

        device.DeviceLost += (_, e) =>
        {
            deviceLost = true;
            Console.Error.WriteLine($"device lost event: {e.Reason}");
        };

        if (announce)
        {
            Console.WriteLine($"device {device.Name} luid {device.Luid} hardware");
        }
        return device;
    }

    private static int Hash(Options options)
    {
        using Heartbeat? heartbeat = options.HeartbeatPath is null ? null : new Heartbeat(options.HeartbeatPath);

        GraphicsDevice? device = HardwareDevice(options.Adapter);
        if (device is null)
        {
            return ExitNoHardwareGpu;
        }

        Console.WriteLine($"elements {options.Elements} rounds {options.Rounds} seed 0x{options.Seed:x8}");

        HashResult result = HashRun.Run(device, options.Elements, options.Rounds, options.Seed);
        double seconds = result.Elapsed.TotalSeconds;

        Console.WriteLine($"dispatches {result.Dispatches}");
        Console.WriteLine($"hash {result.Hash:x16}");
        Console.WriteLine($"elapsed {result.Elapsed.TotalMilliseconds:F3} ms");
        Console.WriteLine($"throughput {result.BytesTouched / seconds / 1e9:F1} GB/s");
        Console.WriteLine($"mix {result.Steps / seconds / 1e9:F1} Gsteps/s");

        ReportHeartbeat(heartbeat);

        if (options.Expect is ulong expected && expected != result.Hash)
        {
            Console.Error.WriteLine($"hash mismatch: expected {expected:x16}");
            return ExitMismatch;
        }

        return ExitOk;
    }

    private static int RunLoad(Options options)
    {
        using Heartbeat? heartbeat = options.HeartbeatPath is null ? null : new Heartbeat(options.HeartbeatPath);

        GraphicsDevice? device = HardwareDevice(options.Adapter);
        if (device is null)
        {
            return ExitNoHardwareGpu;
        }

        Console.WriteLine($"load {options.Kind} seconds {options.Seconds}");
        LoadResult result = Load.Run(device, options.Kind, options.Seconds);
        Console.WriteLine($"dispatches {result.Dispatches}");
        Console.WriteLine($"elapsed {result.Elapsed.TotalMilliseconds:F0} ms");
        Console.WriteLine($"steps {result.Steps}");

        ReportHeartbeat(heartbeat);
        return ExitOk;
    }

    private static int RunBench(Options options)
    {
        using Heartbeat? heartbeat = options.HeartbeatPath is null ? null : new Heartbeat(options.HeartbeatPath);

        // --json promises one line on stdout and nothing else, so the device line stays off it.
        GraphicsDevice? device = HardwareDevice(options.Adapter, announce: !options.Json);
        if (device is null)
        {
            return ExitNoHardwareGpu;
        }

        BenchResult result = BenchRun.Run(device, options.Seconds > 0 ? options.Seconds : BenchRun.DefaultSeconds);

        if (options.Json)
        {
            Console.WriteLine(result.ToJson());
        }
        else
        {
            Console.WriteLine($"buffer {result.BufferBytes} bytes");
            Console.WriteLine($"bandwidth {result.BandwidthGBs:F1} GB/s best of {result.BandwidthPasses} passes, {result.BandwidthMedianGBs:F1} GB/s median");
            Console.WriteLine($"matmul {result.MatmulN} fp32 {result.MatmulTflopsFp32:F2} TFLOPS, fp16 storage {result.MatmulTflopsFp16storage:F2} TFLOPS (median of {BenchRun.MatmulRuns})");
            Console.WriteLine($"elapsed {result.ElapsedMs:F0} ms");
        }

        ReportHeartbeat(heartbeat);
        return ExitOk;
    }

    // A heartbeat that stopped being written does not fail the run, but the supervisor
    // was reading that file to decide whether this process was alive, so say it happened.
    private static void ReportHeartbeat(Heartbeat? heartbeat)
    {
        if (heartbeat?.Failure is string failure)
        {
            Console.Error.WriteLine($"heartbeat writes failed: {failure}");
        }
    }
}
