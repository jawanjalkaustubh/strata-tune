namespace StrataTune.Collector;

/// <summary>
/// The graceful half of the collector shutdown contract (lifecycle audit 2026-09-15, item
/// 32): <c>POST /shutdown</c>. The UI sends it from <c>before-quit</c> with the per-launch
/// token, bounded to 2 s; <see cref="ParentWatch"/> covers every other way the UI can end
/// (crash, End Task, logoff), because an elevated child cannot be killed from medium IL.
/// </summary>
internal static class ShutdownRoute
{
    /// <summary>
    /// Maps <c>POST /shutdown</c>. The token is checked by <see cref="Auth.UseBearerToken"/>,
    /// which runs before every endpoint; a request that reaches this handler answered it. The
    /// 202 goes on the wire first and <paramref name="onShutdown"/> runs once the response has
    /// completed, so the UI's fetch resolves instead of seeing the connection reset.
    /// </summary>
    public static void Map(IEndpointRouteBuilder app, Action onShutdown)
    {
        app.MapPost("/shutdown", (HttpContext ctx) =>
        {
            ctx.Response.OnCompleted(() =>
            {
                onShutdown();
                return Task.CompletedTask;
            });
            return Results.Accepted();
        });
    }
}
