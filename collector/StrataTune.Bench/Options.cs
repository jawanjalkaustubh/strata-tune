using System.Globalization;

namespace StrataTune.Bench;

internal sealed class Options
{
    public const int MaxVramTargetPercent = 90;
    public const int MaxFillRateSeconds = 60;

    public string Script { get; private set; } = "full";
    /// <summary>--fillrate: the pixel-rate measurement instead of the script (FillRate.cs).</summary>
    public bool FillRate { get; private set; }
    /// <summary>Seconds of measured fill after the warm-up; only --fillrate reads it.</summary>
    public int Seconds { get; private set; } = 6;
    public bool VSync { get; private set; }
    public int VramTargetPercent { get; private set; } = 40;
    public bool Json { get; private set; }
    public int Width { get; private set; } = 1280;
    public int Height { get; private set; } = 720;
    public int FpsCap { get; private set; } = 120;
    public string? Adapter { get; private set; }
    public bool Debug { get; private set; }

    /// <exception cref="ArgumentException">An unknown flag, a missing value or a value out of range.</exception>
    public static Options Parse(string[] args)
    {
        Options options = new();
        bool secondsGiven = false;
        int i = 0;

        string Value(string flag) => ++i < args.Length ? args[i] : throw new ArgumentException($"{flag} needs a value");

        for (; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--script": options.Script = ScriptKind(Value("--script")); break;
                case "--fillrate": options.FillRate = true; break;
                case "--seconds": options.Seconds = Number("--seconds", Value("--seconds"), 1, MaxFillRateSeconds); secondsGiven = true; break;
                case "--vsync": options.VSync = true; break;
                case "--vram-target": options.VramTargetPercent = Number("--vram-target", Value("--vram-target"), 1, MaxVramTargetPercent); break;
                case "--json": options.Json = true; break;
                case "--width": options.Width = Number("--width", Value("--width"), 64, 16384); break;
                case "--height": options.Height = Number("--height", Value("--height"), 64, 16384); break;
                case "--fps-cap": options.FpsCap = Number("--fps-cap", Value("--fps-cap"), 0, 10000); break;
                case "--adapter": options.Adapter = Value("--adapter"); break;
                case "--debug": options.Debug = true; break;
                default: throw new ArgumentException($"unknown argument {args[i]}");
            }
        }

        if (secondsGiven && !options.FillRate)
        {
            // The script's length is fixed by design (plan section 11a); a silently ignored flag would suggest otherwise.
            throw new ArgumentException("--seconds only applies to --fillrate; the script's segments have fixed lengths");
        }

        return options;
    }

    private static string ScriptKind(string text) =>
        text is "full" or "short" ? text : throw new ArgumentException($"--script: {text} is not full or short");

    private static int Number(string flag, string text, int min, int max) =>
        int.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out int value) && value >= min && value <= max
            ? value
            : throw new ArgumentException($"{flag}: {text} is not a number in {min}..{max}");
}
