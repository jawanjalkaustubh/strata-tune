using System.Text.Json.Serialization.Metadata;
using StrataTune.Shared;

namespace StrataTune.Collector;

/// <summary>The HTTP surface, kept to routing and status codes; the work is in the classes
/// the handlers call. Every body is serialised through the source-generated context.</summary>
internal static class Endpoints
{
    private const int MinHogSeconds = 2, MaxHogSeconds = 15;

    public static void Map(WebApplication app, CollectorState state)
    {
        app.MapGet("/health", () => Json(state.Health(), WireJson.Default.Health));

        app.MapGet("/snapshot", async () =>
            Json(await Snapshot.CaptureAsync(state.ReadGpus(), state.Log), WireJson.Default.StaticSnapshot));

        app.MapGet("/sensors/meta", () => Json(state.Metas(), WireJson.Default.SensorMetaArray));

        app.MapGet("/sensors/latest", () => Json(state.Buffer.Latest(), WireJson.Default.SensorRow));

        app.MapGet("/sensors/window", (int seconds) => seconds < 1
            ? Error(StatusCodes.Status400BadRequest, "seconds must be at least 1")
            : Json(state.Buffer.Window(seconds), WireJson.Default.SensorWindow));

        app.MapGet("/gpu", () => Json(state.ReadGpus(), WireJson.Default.GpuFactsArray));

        app.MapGet("/stream", (HttpContext context) => SseStream.Handle(context, state));

        // The UI's client calls /procs/hogs (plan section 6's stream name); the short spelling is kept beside it.
        foreach (var path in new[] { "/procs/hogs", "/hogs" })
            app.MapGet(path, async (int seconds, int? excludePid, CancellationToken cancel) =>
                seconds is < MinHogSeconds or > MaxHogSeconds
                    ? Error(StatusCodes.Status400BadRequest, $"seconds must be {MinHogSeconds}..{MaxHogSeconds}")
                    : Json(await Hogs.SampleAsync(seconds, excludePid, cancel), WireJson.Default.HogsResult));

        app.MapPost("/load", (LoadRunRequest request) =>
            state.Loads.TryStart(request, out var run, out var refusal) switch
            {
                LoadRunner.Start.Started => Json(run, WireJson.Default.LoadRun),
                LoadRunner.Start.Busy => Error(StatusCodes.Status409Conflict, refusal),
                _ => Error(StatusCodes.Status400BadRequest, refusal),
            });

        app.MapGet("/load/{id}", (string id) => state.Loads.Get(id) is { } run
            ? Json(run, WireJson.Default.LoadRun)
            : Error(StatusCodes.Status404NotFound, "no such load run"));

        MapTune(app, state.Tune);
    }

    // Plan section 16: every reply carries the whole status, so the page never needs a second
    // round trip to learn what a POST did to the state file.
    private static void MapTune(WebApplication app, TuneSupervisor tune)
    {
        IResult Status() => Json(tune.Status(), WireJson.Default.TuneStatus);
        IResult Outcome((bool Ok, string Message) r) => r.Ok ? Status() : Error(TuneSupervisor.Conflict, r.Message);

        app.MapGet("/tune/state", Status);
        app.MapPost("/tune/enable", (TuneEnableRequest request) => Outcome(tune.SetEnabled(request)));
        app.MapPost("/tune/start", async (TuneStartRequest request) =>
        {
            var (status, refusal) = await tune.TryStartAsync(request);
            return status == StatusCodes.Status200OK ? Status() : Error(status, refusal);
        });
        // The validate run is a kind of start; the client spells it as its own route.
        app.MapPost("/tune/validate", async () =>
        {
            var (status, refusal) = await tune.TryStartAsync(new TuneStartRequest(TuneRunKind.Validate, null, null));
            return status == StatusCodes.Status200OK ? Status() : Error(status, refusal);
        });
        app.MapPost("/tune/stop", () => Outcome(tune.Stop()));
        app.MapPost("/tune/keep", () => Outcome(tune.Keep()));
        app.MapPost("/tune/revert", () => Outcome(tune.Revert()));
        app.MapGet("/tune/export", () => tune.Export() is { } export
            ? Json(export, WireJson.Default.TuneExport)
            : Error(StatusCodes.Status404NotFound, "no result yet: run a hunt first"));
        app.MapGet("/tune/flight", () => FlightRecorder.ReadLastCrash() is { } ndjson
            ? Results.Text(ndjson, "application/x-ndjson")
            : Error(StatusCodes.Status404NotFound, "no flight file: no crash has been found at a start"));
    }

    private static IResult Json<T>(T value, JsonTypeInfo<T> typeInfo) => Results.Json(value, typeInfo);

    private static IResult Error(int status, string error) =>
        Results.Json(new ApiError(error), WireJson.Default.ApiError, statusCode: status);
}
