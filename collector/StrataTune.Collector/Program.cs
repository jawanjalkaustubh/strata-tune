using System.Text;
using StrataTune.Collector;
using StrataTune.Shared;

const string usage = """
    usage:
      strata-tune-collector --probe [--out <file>]
      strata-tune-collector --serve --parent-pid <pid> [--parent-start <epoch ms>] [--handshake <file>] [--log <file>]
      strata-tune-collector --revert-if-pending
    """;

// Before anything can load a native library: this process runs elevated and third-party code
// inside it loads DLLs by bare name (see DllSearch).
DllSearch.RestrictToSystem32AndAppDirectory();

return args.Length == 0 ? Bad("expected --probe, --serve or --revert-if-pending") : args[0] switch
{
    "--probe" => Probe(args),
    "--serve" => Serve.Run(args),
    "--revert-if-pending" => RevertIfPending(),
    _ => Bad($"unknown verb {args[0]}"),
};

// The same pass every --serve start runs first (plan section 16), on its own: read the
// state file, put the baseline back if a rung was left on the card, exit. No port, no
// sensors, no handshake; a failed revert is exit 1.
static int RevertIfPending()
{
    var log = new Log(AppPaths.Log);
    void Say(string line)
    {
        Console.WriteLine(line);
        log.Write($"revert-if-pending: {line}");
    }
    if (TuneStateStore.Load(out var unreadable) is null)
    {
        Say(unreadable ?? $"no state file at {TuneStateStore.FilePath}: nothing pending");
        return unreadable is null ? 0 : 1;
    }
    var store = new TuneStateStore(Say);
    var ok = TuneStateMachine.Reconcile(store, Say, out var outcome);
    if (ok && outcome == TuneRollback.Reverted)
        FlightRecorder.KeepLastCrash(Say);
    Say(ok ? $"state {outcome.Wire()}" : $"revert FAILED, state stays {outcome.Wire()}");
    return ok ? 0 : 1;
}

static int Bad(string reason)
{
    Console.Error.WriteLine(reason);
    Console.Error.WriteLine(usage);
    return 1;
}

static int Probe(string[] args)
{
    string? outPath = null;
    var outIndex = Array.IndexOf(args, "--out");
    if (outIndex >= 0)
    {
        if (outIndex + 1 >= args.Length)
            return Bad("--out needs a file path");
        outPath = args[outIndex + 1];
    }

    // The UI launches this elevated and cannot read its stdout, so --out is the real channel.
    // The report is buffered and flushed even if a block crashes, so partial evidence survives.
    Console.OutputEncoding = Encoding.UTF8;
    var report = new StringWriter();
    try
    {
        return ProbeReport.Write(report);
    }
    finally
    {
        Console.Out.Write(report.ToString());
        if (outPath is not null)
            File.WriteAllText(outPath, report.ToString(), new UTF8Encoding(false));
    }
}
