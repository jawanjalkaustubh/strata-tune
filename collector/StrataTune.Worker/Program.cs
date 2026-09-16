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

            return options.Verb == "--devices" ? ListDevices() : Hash(options);
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

    private static int Hash(Options options)
    {
        using Heartbeat? heartbeat = options.HeartbeatPath is null ? null : new Heartbeat(options.HeartbeatPath);

        GraphicsDevice device = Select(options.Adapter);

        if (!device.IsHardwareAccelerated)
        {
            Console.Error.WriteLine($"no DX12 SM6 hardware adapter was selected: {device.Name} is a software rasteriser");
            return ExitNoHardwareGpu;
        }

        device.DeviceLost += (_, e) =>
        {
            deviceLost = true;
            Console.Error.WriteLine($"device lost event: {e.Reason}");
        };

        Console.WriteLine($"device {device.Name} luid {device.Luid} hardware");
        Console.WriteLine($"elements {options.Elements} rounds {options.Rounds} seed 0x{options.Seed:x8}");

        HashResult result = HashRun.Run(device, options.Elements, options.Rounds, options.Seed);
        double seconds = result.Elapsed.TotalSeconds;

        Console.WriteLine($"dispatches {result.Dispatches}");
        Console.WriteLine($"hash {result.Hash:x16}");
        Console.WriteLine($"elapsed {result.Elapsed.TotalMilliseconds:F3} ms");
        Console.WriteLine($"throughput {result.BytesTouched / seconds / 1e9:F1} GB/s");
        Console.WriteLine($"mix {result.Steps / seconds / 1e9:F1} Gsteps/s");

        // A heartbeat that stopped being written does not fail the run, but the supervisor
        // was reading that file to decide whether this process was alive, so say it happened.
        if (heartbeat?.Failure is string failure)
        {
            Console.Error.WriteLine($"heartbeat writes failed: {failure}");
        }

        if (options.Expect is ulong expected && expected != result.Hash)
        {
            Console.Error.WriteLine($"hash mismatch: expected {expected:x16}");
            return ExitMismatch;
        }

        return ExitOk;
    }
}
