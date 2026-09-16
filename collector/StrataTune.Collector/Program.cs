using System.Text;
using StrataTune.Collector;

const string usage = "usage: strata-tune-collector --probe [--out <file>]";

// Before anything can load a native library: this process runs elevated and third-party code
// inside it loads DLLs by bare name (see DllSearch).
DllSearch.RestrictToSystem32AndAppDirectory();

// Verbs: --probe [--out <file>]. Phase 1 adds the Kestrel server verb.
if (args.Length == 0 || args[0] != "--probe")
{
    Console.Error.WriteLine(usage);
    return 1;
}

string? outPath = null;
var outIndex = Array.IndexOf(args, "--out");
if (outIndex >= 0)
{
    if (outIndex + 1 >= args.Length)
    {
        Console.Error.WriteLine("--out needs a file path");
        Console.Error.WriteLine(usage);
        return 1;
    }

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
