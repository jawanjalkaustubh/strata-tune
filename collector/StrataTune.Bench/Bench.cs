using System.Diagnostics;

namespace StrataTune.Bench;

/// <summary>The frame loop: plays the script against the clock, records one frame per pass and
/// paces to the fps cap, or in the GPU-load segment to the duty cycle that keeps the card ~90 % busy.</summary>
internal static class Bench
{
    private const uint HeavyStart = 256;
    private const uint HeavyMax = 1 << 18;
    private const double HeavyStep = 1.25;

    private sealed class SegmentStats
    {
        public int Frames;
        public double Seconds;
        public double MaxMs;
        public int GpuSamples;
        public double GpuMsSum;
    }

    public static Summary Run(Options options, Script script, Window window, Gpu gpu, Scene scene, Streaming streaming, Func<bool> cancelled)
    {
        SegmentStats[] stats = Enumerable.Range(0, Script.Names.Length).Select(_ => new SegmentStats()).ToArray();
        double capPeriod = options.FpsCap > 0 ? 1.0 / options.FpsCap : 0;
        int batches = 0, bursts = 0, spins = 0, frames = 0, announced = -1;
        uint heavy = 0;
        double lastGpuMs = 0;
        int framesSinceHeavyChange = 0;
        bool completed = false;

        long origin = Stopwatch.GetTimestamp();
        long frameStart = origin;

        while (true)
        {
            // The pump is what lets the close button and Esc end the run; without it the window
            // would still draw but Windows would call it not responding.
            window.Pump();
            if (window.Closed || cancelled())
            {
                break;
            }

            double now = Stopwatch.GetElapsedTime(origin).TotalSeconds;
            if (now >= script.Total)
            {
                completed = true;
                break;
            }

            int segment = script.SegmentAt(now);
            double local = now - script.Start(segment);
            if (segment != announced && !options.Json)
            {
                Console.WriteLine($"segment {Script.Names[segment]} at {now:F1} s");
                announced = segment;
            }

            if (segment == Script.ShaderCompile && batches < script.PipelineStateBatches && local >= batches)
            {
                scene.CompilePipelineStates(script.PipelineStateBatchSize(batches++));
            }

            bool burst = segment == Script.TextureStream && bursts < Script.Bursts && local >= bursts * script.BurstInterval;

            if (segment == Script.CpuStall && local >= spins * script.SpinInterval)
            {
                Pacing.Spin(Script.SpinMs);
                spins++;
            }

            if (segment > Script.TextureStream)
            {
                streaming.Release(gpu);
            }

            if (segment == Script.GpuLoad && heavy == 0)
            {
                heavy = HeavyStart;
            }

            if (gpu.BeginFrame() is (int measuredSegment, double gpuMs))
            {
                stats[measuredSegment].GpuSamples++;
                stats[measuredSegment].GpuMsSum += gpuMs;
                if (measuredSegment == Script.GpuLoad)
                {
                    lastGpuMs = gpuMs;
                    // A measurement describes the load of three frames ago; adjust only once every
                    // frame in flight has run at the current count, or the loop chases its own tail.
                    if (++framesSinceHeavyChange >= Gpu.FrameCount)
                    {
                        heavy = Adjust(heavy, gpuMs);
                        framesSinceHeavyChange = 0;
                    }
                }
            }

            scene.Draw(gpu.List, gpu.Slot, (float)now, heavy);
            if (burst)
            {
                streaming.RecordBurst(gpu.List, gpu.PendingFence);
                bursts++;
            }
            gpu.EndFrame(segment, options.VSync);
            frames++;

            double period = capPeriod;
            if (segment == Script.GpuLoad && lastGpuMs > 0)
            {
                period = Math.Max(period, lastGpuMs / 1000 / Script.GpuDuty);
            }
            if (period > 0)
            {
                Pacing.SleepUntil(frameStart + (long)(period * Stopwatch.Frequency));
            }

            long frameEnd = Stopwatch.GetTimestamp();
            double frameMs = (frameEnd - frameStart) * 1000.0 / Stopwatch.Frequency;
            frameStart = frameEnd;
            stats[segment].Frames++;
            stats[segment].Seconds += frameMs / 1000;
            stats[segment].MaxMs = Math.Max(stats[segment].MaxMs, frameMs);
        }

        SegmentSummary[] segments = stats.Select((s, i) => new SegmentSummary(
            Script.Names[i],
            script.Start(i),
            script.End(i),
            s.Frames,
            s.Seconds > 0 ? Math.Round(s.Frames / s.Seconds, 1) : 0,
            Math.Round(s.MaxMs, 2),
            s.GpuSamples > 0 ? Math.Round(s.GpuMsSum / s.GpuSamples, 3) : 0)).ToArray();

        return new Summary(
            script.Kind,
            gpu.Name,
            gpu.Luid,
            Environment.ProcessId,
            gpu.Width,
            gpu.Height,
            options.VSync,
            options.FpsCap,
            options.VramTargetPercent,
            completed,
            frames,
            Math.Round(Stopwatch.GetElapsedTime(origin).TotalSeconds, 2),
            segments,
            scene.PipelineStates,
            streaming.Uploaded,
            (long)(streaming.UploadedBytes >> 20),
            heavy);
    }

    // Proportional control toward the target GPU time, at most a quarter step per change.
    private static uint Adjust(uint heavy, double gpuMs) =>
        (uint)Math.Clamp(heavy * Math.Clamp(Script.GpuTargetMs / Math.Max(gpuMs, 0.05), 1 / HeavyStep, HeavyStep), 1, HeavyMax);
}
