namespace StrataTune.Collector;

/// <summary>The sensor sources, filled in one by one after the handshake is written so the
/// UI connects while they open (phase1-polish item 8). A source that failed to open stays
/// null and /health reports the gap; <see cref="Warming"/> holds until every source has had
/// its turn and the library's hardware groups are all in.</summary>
internal sealed class Sources
{
    public volatile Nvml.Session? Nvml;
    public volatile NvmlSampler? NvmlSampler;
    public volatile LhmSampler? Lhm;
    public volatile PdhSampler? Pdh;
    public volatile bool Warming = true;
}
