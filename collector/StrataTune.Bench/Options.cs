using System.Globalization;

namespace StrataTune.Bench;

internal sealed class Options
{
    public const int MaxVramTargetPercent = 90;

    public string Script { get; private set; } = "full";
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
        int i = 0;

        string Value(string flag) => ++i < args.Length ? args[i] : throw new ArgumentException($"{flag} needs a value");

        for (; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--script": options.Script = ScriptKind(Value("--script")); break;
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

        return options;
    }

    private static string ScriptKind(string text) =>
        text is "full" or "short" ? text : throw new ArgumentException($"--script: {text} is not full or short");

    private static int Number(string flag, string text, int min, int max) =>
        int.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out int value) && value >= min && value <= max
            ? value
            : throw new ArgumentException($"{flag}: {text} is not a number in {min}..{max}");
}
