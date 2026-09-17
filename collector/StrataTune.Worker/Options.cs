using System.Globalization;

namespace StrataTune.Worker;

internal sealed class Options
{
    /// <summary>AllocateReadWriteBuffer refuses more than 2 GiB of uint (it throws
    /// ArgumentOutOfRangeException from inside ComputeSharp), so the flag says so instead.</summary>
    public const int MaxElements = 1 << 29;

    public const int MaxSeconds = 3600;
    // Far past any logical CPU count; the flag exists to run fewer threads, not more.
    public const int MaxThreads = 1024;

    public string Verb { get; private set; } = "";
    public int Elements { get; private set; } = 1 << 24;
    public int Rounds { get; private set; } = 256;
    public uint Seed { get; private set; } = 0x53545241;
    public ulong? Expect { get; private set; }
    public string? HeartbeatPath { get; private set; }
    public string? Adapter { get; private set; }
    public bool Json { get; private set; }
    public string Kind { get; private set; } = "";
    public int Seconds { get; private set; }
    /// <summary>--ladder's load shape; required there, meaningless elsewhere.</summary>
    public Pattern? Pattern { get; private set; }
    /// <summary>--cpu-load threads; every logical CPU unless --threads says otherwise.</summary>
    public int Threads { get; private set; } = Environment.ProcessorCount;

    /// <exception cref="ArgumentException">An unknown flag, a missing value or a value out of range.</exception>
    public static Options Parse(string[] args)
    {
        Options options = new();
        int i = 0;

        string Value(string flag) => ++i < args.Length ? args[i] : throw new ArgumentException($"{flag} needs a value");

        for (; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--devices" or "--hash" or "--reference": options.Verb = args[i]; break;
                case "--load": options.Verb = args[i]; options.Kind = LoadKind(Value("--load")); break;
                case "--bench" or "--cpu-load" or "--ladder": options.Verb = args[i]; break;
                case "--pattern": options.Pattern = Patterns.Parse(Value("--pattern")); break;
                case "--threads": options.Threads = Positive("--threads", Value("--threads"), MaxThreads); break;
                case "--seconds": options.Seconds = Positive("--seconds", Value("--seconds"), MaxSeconds); break;
                case "--elements": options.Elements = Positive("--elements", Value("--elements"), MaxElements); break;
                case "--rounds": options.Rounds = Positive("--rounds", Value("--rounds")); break;
                case "--seed": options.Seed = (uint)Number("--seed", Value("--seed"), uint.MaxValue); break;
                case "--expect": options.Expect = Hex("--expect", Value("--expect")); break;
                case "--heartbeat": options.HeartbeatPath = Value("--heartbeat"); break;
                case "--adapter": options.Adapter = Value("--adapter"); break;
                case "--json": options.Json = true; break;
                default: throw new ArgumentException($"unknown argument {args[i]}");
            }
        }

        if (options.Verb.Length == 0)
        {
            throw new ArgumentException("expected --devices, --hash, --reference, --load, --ladder, --cpu-load or --bench");
        }

        if (options.Verb is "--load" or "--cpu-load" && options.Seconds == 0)
        {
            throw new ArgumentException($"{options.Verb} needs --seconds N");
        }

        if (options.Verb == "--ladder" && (options.Pattern is null || options.Seconds == 0 || options.Expect is null))
        {
            throw new ArgumentException("--ladder needs --pattern variable|sustained, --seconds N and --expect HEX from --reference");
        }

        return options;
    }

    private static string LoadKind(string text) =>
        text is "light" or "heavy" ? text : throw new ArgumentException($"--load: {text} is not light or heavy");

    private static int Positive(string flag, string text, int max = int.MaxValue) =>
        (int)Number(flag, text, (ulong)max) is > 0 and int value
            ? value
            : throw new ArgumentException($"{flag} must be at least 1");

    // Decimal or 0x-prefixed hex, so the same value can be pasted back from our own output.
    private static ulong Number(string flag, string text, ulong max)
    {
        bool ok = text.StartsWith("0x", StringComparison.OrdinalIgnoreCase)
            ? ulong.TryParse(text.AsSpan(2), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out ulong value)
            : ulong.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out value);

        return ok && value <= max ? value : throw new ArgumentException($"{flag}: {text} is not a number in 0..{max}");
    }

    private static ulong Hex(string flag, string text)
    {
        ReadOnlySpan<char> digits = text.StartsWith("0x", StringComparison.OrdinalIgnoreCase) ? text.AsSpan(2) : text;

        return digits.Length == 16 && ulong.TryParse(digits, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out ulong value)
            ? value
            : throw new ArgumentException($"{flag}: {text} is not a 16-digit hex hash");
    }
}
