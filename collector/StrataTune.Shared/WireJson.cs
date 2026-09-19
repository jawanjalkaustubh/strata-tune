using System.Text.Json.Serialization;

namespace StrataTune.Shared;

/// <summary>Source-generated serialiser for the wire contract (src/collector-types.ts):
/// camelCase members, enums as strings. No reflection, so single-file and trimming stay
/// open.</summary>
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, UseStringEnumConverter = true)]
[JsonSerializable(typeof(Health))]
[JsonSerializable(typeof(Handshake))]
[JsonSerializable(typeof(ApiError))]
[JsonSerializable(typeof(SensorMeta[]))]
[JsonSerializable(typeof(SensorRow))]
[JsonSerializable(typeof(SensorWindow))]
[JsonSerializable(typeof(GpuFacts[]))]
[JsonSerializable(typeof(StaticSnapshot))]
[JsonSerializable(typeof(HogsResult))]
[JsonSerializable(typeof(LoadRunRequest))]
[JsonSerializable(typeof(LoadRun))]
[JsonSerializable(typeof(FillRateResult))]
[JsonSerializable(typeof(Tick))]
[JsonSerializable(typeof(TuneFile))]
[JsonSerializable(typeof(TuneStatus))]
[JsonSerializable(typeof(TuneRun))]
[JsonSerializable(typeof(TuneStartRequest))]
[JsonSerializable(typeof(TuneEnableRequest))]
[JsonSerializable(typeof(TuneExport))]
[JsonSerializable(typeof(Timers))]
public sealed partial class WireJson : JsonSerializerContext;
