using System.Text.Json;
using StrataTune.Shared;

namespace StrataTune.Collector;

/// <summary>What Ollama holds in memory right now, for the AI advisor's view of the GPU
/// (plan section 10). A daemon that is not running is null, not an error, and it gets one
/// second: the snapshot must not wait on a service that may not exist.</summary>
internal static class Ollama
{
    private const string PsUrl = "http://127.0.0.1:11434/api/ps";

    private static readonly HttpClient Client = new(new SocketsHttpHandler { UseProxy = false })
    {
        Timeout = TimeSpan.FromSeconds(1),
    };

    public static async Task<IReadOnlyList<OllamaModel>?> ModelsAsync()
    {
        try
        {
            using var document = JsonDocument.Parse(await Client.GetByteArrayAsync(PsUrl));
            return document.RootElement.GetProperty("models").EnumerateArray()
                .Select(m => new OllamaModel(
                    m.GetProperty("name").GetString() ?? "",
                    m.TryGetProperty("size", out var size) ? size.GetInt64() : 0,
                    m.TryGetProperty("size_vram", out var vram) ? vram.GetInt64() : 0))
                .ToList();
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or JsonException or KeyNotFoundException or InvalidOperationException)
        {
            return null;
        }
    }
}
