using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Serialization;
using ComputeSharp;

namespace StrataTune.Worker;

/// <summary>The one JSON line of <c>--reference --json</c>; member order is the wire order.
/// The hash is printed as the 16 hex digits <c>--expect</c> reads back.</summary>
internal sealed record ReferenceResult(
    string Device,
    string Luid,
    int Elements,
    int Rounds,
    string Seed,
    string Hash,
    double ElapsedMs,
    [property: JsonIgnore] bool Stable)
{
    public string ToJson() => JsonSerializer.Serialize(this, ReferenceJson.Default.ReferenceResult);
}

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(ReferenceResult))]
internal sealed partial class ReferenceJson : JsonSerializerContext;

/// <summary>
/// The ladder's stage-1 detector (plan section 16): the hash kernel at one fixed
/// configuration, so its fold is the same number at every clock the card runs correctly.
/// <c>--reference</c> captures it at the baseline before any offset is applied, the
/// supervisor stores it and hands it back as <c>--expect</c>; a pass that folds to anything
/// else is a silent compute error at that candidate. Integer maths only, so the number is
/// the same across drivers (dependencies.md). Sized so one pass is a few milliseconds on a
/// modern discrete card and a few tens on an integrated one: it runs after every heavy
/// dispatch and once a second under the light pattern, which has to stay light. The fold of
/// the 4 MiB result is the CPU's share and most of the pass on a fast card.
/// </summary>
internal static class Reference
{
    public const int Elements = 1 << 20;
    public const int Rounds = 1024;
    public const uint Seed = 0x53545241;

    /// <summary>Two passes, agreeing. A card that cannot repeat its own baseline has no
    /// reference, and a ladder run against a wrong one would fail every candidate.</summary>
    public static ReferenceResult Capture(GraphicsDevice device)
    {
        long started = Stopwatch.GetTimestamp();
        using ReferencePass pass = new(device);
        ulong first = pass.Run();
        ulong second = pass.Run();

        return new ReferenceResult(
            device.Name,
            device.Luid.ToString(),
            Elements,
            Rounds,
            $"0x{Seed:x8}",
            $"{first:x16}",
            Math.Round(Stopwatch.GetElapsedTime(started).TotalMilliseconds, 1),
            Stable: first == second);
    }
}

/// <summary>One verified pass at a time over a buffer kept for the run.</summary>
internal sealed class ReferencePass : IDisposable
{
    private readonly GraphicsDevice device;
    private readonly ReadWriteBuffer<uint> slots;
    private readonly uint[] zeros = new uint[Reference.Elements];
    private readonly uint[] chunk = new uint[Reference.Elements];

    public ReferencePass(GraphicsDevice device)
    {
        this.device = device;
        slots = device.AllocateReadWriteBuffer<uint>(Reference.Elements);
    }

    // Every pass starts from the cleared buffer a fresh --hash starts from, so it folds to
    // the same number as `--hash --elements 1048576 --rounds 1024` and as every other pass.
    public ulong Run()
    {
        slots.CopyFrom(zeros);

        return HashRun.Run(device, slots, Reference.Rounds, Reference.Seed, chunk).Hash;
    }

    public void Dispose() => slots.Dispose();
}
