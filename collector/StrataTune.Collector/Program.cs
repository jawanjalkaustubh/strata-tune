using System.Text;
using StrataTune.Collector;

const string usage = """
    usage:
      strata-tune-collector --probe [--out <file>]
      strata-tune-collector --serve --parent-pid <pid> [--parent-start <epoch ms>] [--handshake <file>] [--log <file>]
    """;

// Before anything can load a native library: this process runs elevated and third-party code
// inside it loads DLLs by bare name (see DllSearch).
DllSearch.RestrictToSystem32AndAppDirectory();

return args.Length == 0 ? Bad("expected --probe or --serve") : args[0] switch
{
    "--probe" => Probe(args),
    "--serve" => Serve.Run(args),
    _ => Bad($"unknown verb {args[0]}"),
};

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
