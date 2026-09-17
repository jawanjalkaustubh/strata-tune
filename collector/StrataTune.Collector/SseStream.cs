using System.Text.Json;
using StrataTune.Shared;

namespace StrataTune.Collector;

/// <summary>GET /stream: one "tick" event at 2 Hz per client with the latest row of every
/// source and the live GPU facts, plus a comment line every ten seconds so an idle proxy or
/// a half-open socket is noticed. Each client gets its own loop; the UI opens one.</summary>
internal static class SseStream
{
    private static readonly TimeSpan TickPeriod = TimeSpan.FromMilliseconds(500);
    private static readonly TimeSpan HeartbeatPeriod = TimeSpan.FromSeconds(10);

    private static int _clients;

    public static async Task Handle(HttpContext context, CollectorState state)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted, state.Stopping);
        var stopping = linked.Token;
        var response = context.Response;
        response.ContentType = "text/event-stream";
        response.Headers.CacheControl = "no-cache";
        await response.StartAsync(stopping);

        var count = Interlocked.Increment(ref _clients);
        state.Log.Write($"stream client connected from port {context.Connection.RemotePort}, {count} open");
        var lastHeartbeat = DateTimeOffset.UtcNow;
        try
        {
            using var timer = new PeriodicTimer(TickPeriod);
            while (await timer.WaitForNextTickAsync(stopping))
            {
                var json = JsonSerializer.Serialize(state.Tick(), WireJson.Default.Tick);
                await response.WriteAsync($"event: tick\ndata: {json}\n\n", stopping);
                // The tune monitor's numbers ride the same 2 Hz (plan section 16); nothing is sent while no run goes (a finished one rides a few seconds more so the page sees it end).
                if (state.Tune.RunForStream() is { } run)
                    await response.WriteAsync($"event: tune\ndata: {JsonSerializer.Serialize(run, WireJson.Default.TuneRun)}\n\n", stopping);

                var now = DateTimeOffset.UtcNow;
                if (now - lastHeartbeat >= HeartbeatPeriod)
                {
                    await response.WriteAsync(": keep-alive\n\n", stopping);
                    lastHeartbeat = now;
                }

                await response.Body.FlushAsync(stopping);
            }
        }
        catch (Exception e) when (e is OperationCanceledException or IOException)
        {
            // The client went away or the service is stopping; either ends the stream quietly.
        }
        finally
        {
            count = Interlocked.Decrement(ref _clients);
            state.Log.Write($"stream client from port {context.Connection.RemotePort} disconnected, {count} open");
        }
    }
}
