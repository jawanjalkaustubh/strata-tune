using System.Diagnostics;
using StrataTune.Shared;

namespace StrataTune.Collector;

/// <summary>The sensor stream, sized by time (plan section 6): every row at full rate for the
/// last ten minutes, then folded into one-second min/max/mean summaries kept for up to four
/// hours or a fixed byte budget, whichever runs out first. Each source appends rows keyed
/// by its own id array, which is shared between that source's rows so a row costs one float
/// per sensor; NaN in a row means "no reading this tick".</summary>
internal sealed class RingBuffer
{
    private const int FullRateSeconds = 10 * 60;
    private const int SummarySeconds = 4 * 60 * 60;
    private const long SummaryBudgetBytes = 64L << 20;
    // A window response is thinned until its JSON fits in about this many bytes.
    private const int PayloadBudgetBytes = 5 << 19;
    private const int BytesPerValue = 32;

    private readonly record struct Row(long Qpc, string[] Ids, float[] Values);

    private sealed record Summary(long QpcStart, long QpcEnd, string[] Ids, float[] Min, float[] Max, float[] Mean);

    // A sensor that stops reporting (a hardware node that went away, a GPU that powered down)
    // must drop out of the latest row rather than sit there at its last value stamped with
    // the newest qpc: past this many seconds without a finite reading it is left out.
    private const int StaleSeconds = 3;

    private readonly Lock _gate = new();
    private readonly Queue<Row> _rows = new();
    private readonly Queue<Summary> _summaries = new();
    private readonly Dictionary<string, (float Value, long Qpc)> _latest = new();
    private long _latestQpc;

    // The union of every source's ids, rebuilt only when a source hands in a new array, so
    // consecutive summaries share one ids array too.
    private readonly HashSet<string[]> _idArrays = new(ReferenceEqualityComparer.Instance);
    private string[] _foldIds = [];
    private Dictionary<string, int> _foldIndex = new();

    public void Append(long qpc, string[] ids, float[] values)
    {
        lock (_gate)
        {
            _rows.Enqueue(new Row(qpc, ids, values));
            if (qpc > _latestQpc)
                _latestQpc = qpc;
            for (var i = 0; i < ids.Length; i++)
                if (float.IsFinite(values[i]))
                    _latest[ids[i]] = (values[i], qpc);
            if (_idArrays.Add(ids))
                RebuildFoldIds();
            Fold(qpc);
        }
    }

    public SensorRow Latest()
    {
        lock (_gate)
        {
            var cutoff = _latestQpc - StaleSeconds * Stopwatch.Frequency;
            var values = new Dictionary<string, float>(_latest.Count);
            foreach (var (id, (value, qpc)) in _latest)
                if (qpc >= cutoff)
                    values[id] = value;
            return new SensorRow(_latestQpc, values);
        }
    }

    public SensorWindow Window(int seconds)
    {
        var now = Stopwatch.GetTimestamp();
        var from = now - seconds * Stopwatch.Frequency;
        lock (_gate)
        {
            if (seconds <= FullRateSeconds)
            {
                var rows = _rows.Where(r => r.Qpc >= from).ToList();
                var stride = Stride(rows.Sum(r => 20L + BytesPerValue * r.Values.Count(float.IsFinite)));
                return new SensorWindow(seconds, now, Thin(rows, stride).Select(ToRow).ToList(), []);
            }

            // Past ten minutes the answer is summaries all the way to now: the stored ones,
            // then the full-rate rows folded on the fly so the recent end is not a hole.
            var summaries = _summaries.Where(s => s.QpcEnd >= from).ToList();
            summaries.AddRange(_rows.Where(r => r.Qpc >= from)
                .GroupBy(r => r.Qpc / Stopwatch.Frequency)
                .OrderBy(g => g.Key)
                .Select(g => Summarise(g.ToList())));
            var summaryStride = Stride(summaries.Sum(s => 40L + 3L * BytesPerValue * s.Ids.Length));
            return new SensorWindow(seconds, now, [], summaries.Where((_, i) => i % summaryStride == 0).Select(ToSummary).ToList());
        }
    }

    private static int Stride(long estimatedBytes) =>
        (int)Math.Max(1, (estimatedBytes + PayloadBudgetBytes - 1) / PayloadBudgetBytes);

    // Thinned per source rather than across the merged list, so a 1 Hz source is not wiped
    // out by a 10 Hz one; the result is put back in time order.
    private static IEnumerable<Row> Thin(List<Row> rows, int stride)
    {
        if (stride == 1)
            return rows;
        var kept = new List<Row>(rows.Count / stride + 1);
        foreach (var source in rows.GroupBy(r => r.Ids, ReferenceEqualityComparer.Instance))
            kept.AddRange(source.Where((_, i) => i % stride == 0));
        return kept.OrderBy(r => r.Qpc);
    }

    private static SensorRow ToRow(Row row)
    {
        var values = new Dictionary<string, float>(row.Ids.Length);
        for (var i = 0; i < row.Ids.Length; i++)
            if (float.IsFinite(row.Values[i]))
                values[row.Ids[i]] = row.Values[i];
        return new SensorRow(row.Qpc, values);
    }

    private static SensorSummaryRow ToSummary(Summary s)
    {
        var min = new Dictionary<string, float>(s.Ids.Length);
        var max = new Dictionary<string, float>(s.Ids.Length);
        var mean = new Dictionary<string, float>(s.Ids.Length);
        for (var i = 0; i < s.Ids.Length; i++)
        {
            if (!float.IsFinite(s.Mean[i]))
                continue;
            min[s.Ids[i]] = s.Min[i];
            max[s.Ids[i]] = s.Max[i];
            mean[s.Ids[i]] = s.Mean[i];
        }
        return new SensorSummaryRow(s.QpcStart, s.QpcEnd, min, max, mean);
    }

    private void RebuildFoldIds()
    {
        _idArrays.Clear();
        foreach (var row in _rows)
            _idArrays.Add(row.Ids);
        _foldIds = _idArrays.SelectMany(a => a).Distinct(StringComparer.Ordinal).ToArray();
        _foldIndex = _foldIds.Select((id, i) => (id, i)).ToDictionary(p => p.id, p => p.i, StringComparer.Ordinal);
    }

    private void Fold(long now)
    {
        var fullRateCutoff = now - (long)FullRateSeconds * Stopwatch.Frequency;
        while (_rows.Count > 0 && _rows.Peek().Qpc < fullRateCutoff)
        {
            // Rows are appended in real time, so they leave the queue in near time order; the
            // whole second goes at once, and a row that arrived a few milliseconds late still
            // folds into the bucket it belongs to.
            var bucket = _rows.Peek().Qpc / Stopwatch.Frequency;
            var second = new List<Row>();
            while (_rows.Count > 0 && _rows.Peek().Qpc / Stopwatch.Frequency <= bucket)
                second.Add(_rows.Dequeue());
            _summaries.Enqueue(Summarise(second));
        }

        var summaryCutoff = now - (long)SummarySeconds * Stopwatch.Frequency;
        var cap = Math.Max(1, SummaryBudgetBytes / (3L * sizeof(float) * Math.Max(1, _foldIds.Length) + 64));
        while (_summaries.Count > 0 && (_summaries.Peek().QpcEnd < summaryCutoff || _summaries.Count > cap))
            _summaries.Dequeue();
    }

    private Summary Summarise(IReadOnlyList<Row> rows)
    {
        var n = _foldIds.Length;
        var min = new float[n];
        var max = new float[n];
        var sum = new double[n];
        var count = new int[n];
        Array.Fill(min, float.PositiveInfinity);
        Array.Fill(max, float.NegativeInfinity);
        long start = long.MaxValue, end = long.MinValue;

        foreach (var row in rows)
        {
            start = Math.Min(start, row.Qpc);
            end = Math.Max(end, row.Qpc);
            for (var i = 0; i < row.Ids.Length; i++)
            {
                var v = row.Values[i];
                if (!float.IsFinite(v))
                    continue;
                var k = _foldIndex[row.Ids[i]];
                if (v < min[k]) min[k] = v;
                if (v > max[k]) max[k] = v;
                sum[k] += v;
                count[k]++;
            }
        }

        var mean = new float[n];
        for (var k = 0; k < n; k++)
            mean[k] = count[k] == 0 ? float.NaN : (float)(sum[k] / count[k]);
        return new Summary(start, end, _foldIds, min, max, mean);
    }
}
