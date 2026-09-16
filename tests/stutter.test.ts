import { describe, expect, it } from 'vitest';
import type { HogsResult, SensorMeta, SensorWindow, StaticSnapshot } from '../src/collector-types';
import { judgeBound } from '../src/analysis/bound';
import { WARMUP_FRAMES } from '../src/analysis/frames';
import { analyseSession, buildReport, classify, detectStutters, type ClassifyExtras } from '../src/analysis/stutter';
import type { CaptureSession, FrameRow, StutterEvent } from '../src/analysis/session-types';
import { during, gpuTimeline, HZ, marks, QPC0, sensorWindow, session, spikesAt, steady, VRAM_TOTAL_MIB } from './fixtures/frames';

const causeIds = (events: StutterEvent[]) => events.map((e) => e.cause?.id ?? null);
const run = (s: CaptureSession, extras?: ClassifyExtras) => classify(detectStutters(s.frames).events, s, extras);
const report = (s: CaptureSession, extras?: ClassifyExtras) => analyseSession(s, extras);
/** One frame of `ms` at index `at` in an otherwise steady stream. */
const oneAt = (at: number, ms: number) => (_: number, i: number) => (i === at ? { ms } : null);
const stall = (when: number[], ms = 40) => spikesAt(when, ms, 'cpu');
const usedAt = (share: number) => Math.round(share * VRAM_TOTAL_MIB);

describe('detectStutters', () => {
  it('finds two 40 ms spikes in a steady 8 ms stream and the time they cost', () => {
    const frames = steady(120, 8, spikesAt([1, 30, 90], 40));
    const d = detectStutters(frames);
    expect(d.stutterCount).toBe(2);
    expect(d.events.map((e) => e.kind)).toEqual(['spike', 'spike']);
    expect(d.events.every((e) => e.index >= WARMUP_FRAMES)).toBe(true);
    expect(d.events[0].medianMs).toBe(8);
    expect(d.percentTimeLost).toBeCloseTo((100 * 2 * 32) / d.totalMs, 6);
    expect(d.typicalFrameMs).toBe(8);
    expect(d.pacingStdevMs).toBe(0);
    expect(d.worst1PctMs).toBe(8);
    expect(d.analysedFrames).toBe(frames.length - WARMUP_FRAMES);
  });

  it('trips the 50 ms floor even when the median is high', () => {
    const frames = steady(20, 30, spikesAt([10], 55));
    const d = detectStutters(frames);
    expect(d.stutterCount).toBe(1);
    expect(d.events[0].kind).toBe('absolute');
  });

  it('leaves the pacing number to the non-stutter frames', () => {
    const frames = steady(20, 8, (t, i) => (t > 5 ? { ms: i % 2 ? 8.5 : 7.5 } : null));
    const d = detectStutters(frames);
    expect(d.stutterCount).toBe(0);
    expect(d.pacingStdevMs).toBeCloseTo(0.5, 1);
  });

  it('has nothing to say before the level load is over', () => {
    const d = detectStutters(steady(2, 8, spikesAt([1], 40)));
    expect(d.analysedFrames).toBe(0);
    expect(d.stutterCount).toBe(0);
  });

  it('pins the 2× rule: 15.9 ms on an 8 ms median passes, 16.1 ms is a stutter', () => {
    expect(detectStutters(steady(20, 8, oneAt(400, 15.9))).stutterCount).toBe(0);
    expect(detectStutters(steady(20, 8, oneAt(400, 16.1))).stutterCount).toBe(1);
  });

  it('pins the 50 ms floor: 49 ms on a 30 ms median passes, 51 ms is an absolute stutter', () => {
    expect(detectStutters(steady(30, 30, oneAt(400, 49))).stutterCount).toBe(0);
    expect(detectStutters(steady(30, 30, oneAt(400, 50))).stutterCount).toBe(0);
    const d = detectStutters(steady(30, 30, oneAt(400, 51)));
    expect(d.stutterCount).toBe(1);
    expect(d.events[0].kind).toBe('absolute');
  });

  it('pins the 300-frame skip: a spike at 299 is the level load, 300 seeds the window, 301 is judged', () => {
    expect(detectStutters(steady(20, 8, oneAt(WARMUP_FRAMES - 1, 40))).stutterCount).toBe(0);
    expect(detectStutters(steady(20, 8, oneAt(WARMUP_FRAMES, 40))).stutterCount).toBe(0);
    const d = detectStutters(steady(20, 8, oneAt(WARMUP_FRAMES + 1, 40)));
    expect(d.events.map((e) => [e.index, e.medianMs])).toEqual([[WARMUP_FRAMES + 1, 8]]);
  });

  it('judges a hitch right after the level load against play, not against loading', () => {
    // 300 frames of 100 ms loading, then 8 ms play with one 30 ms frame ten frames in.
    const frames = steady(60, 8, (_, i) => (i < WARMUP_FRAMES ? { ms: 100 } : i === WARMUP_FRAMES + 10 ? { ms: 30 } : null));
    const d = detectStutters(frames);
    expect(d.stutterCount).toBe(1);
    expect(d.events[0].medianMs).toBe(8);
    expect(d.typicalFrameMs).toBe(8);
  });
});

describe('classify', () => {
  it('case 1: GPU-busy spikes that thin out over five minutes are shader compilation, high', () => {
    const when = [...marks(10, 70, 1), ...marks(70, 130, 2), ...marks(130, 190, 4), ...marks(190, 300, 8)];
    const s = session(steady(300, 8, spikesAt(when, 40, 'gpu')), { gpuTimeline: gpuTimeline(300) });
    const events = run(s);
    expect(events.length).toBe(when.length);
    expect(new Set(causeIds(events))).toEqual(new Set(['shader-compile']));
    expect(events[0].cause).toMatchObject({ case: 1, fixable: true, confidence: 'high' });
    expect(events[0].cause!.evidence[1]).toMatch(/% fewer/);
  });

  it('case 2: a clock drop with the thermal bit, even on a regular beat, is thermal throttling', () => {
    const when = [30, 35, 40, 45, 50];
    const s = session(steady(60, 8, spikesAt(when, 40, 'gpu')), {
      gpuTimeline: gpuTimeline(60, (t) => (during(when, 1)(t) ? { smMhz: 2400, reasons: 0x40, temperatureC: 84 } : {}))
    });
    const events = run(s);
    expect(events).toHaveLength(5);
    expect(new Set(causeIds(events))).toEqual(new Set(['thermal']));
    expect(events[0].cause).toMatchObject({ case: 2, fixable: true, confidence: 'high' });
  });

  it('case 2 on temperature alone is low confidence', () => {
    const when = [20, 30, 40, 50];
    const s = session(steady(60, 8, spikesAt(when, 40, 'gpu')), {
      gpuTimeline: gpuTimeline(60, (t) => (during(when, 1)(t) ? { smMhz: 2400, temperatureC: 84 } : {}))
    });
    expect(run(s)[0].cause).toMatchObject({ id: 'thermal', confidence: 'low' });
  });

  it('case 3: the power-cap bit with normal temperatures is the power limit', () => {
    const when = [20, 30, 40, 50];
    const s = session(steady(60, 8, spikesAt(when, 40, 'gpu')), {
      gpuTimeline: gpuTimeline(60, (t) => (during(when, 1)(t) ? { smMhz: 2400, reasons: 0x4, temperatureC: 65, powerMw: 590_000 } : {}))
    });
    const events = run(s);
    expect(new Set(causeIds(events))).toEqual(new Set(['power-limit']));
    expect(events[0].cause).toMatchObject({ case: 3, fixable: true, confidence: 'high' });
  });

  it('case 4: video memory at 95 % and climbing', () => {
    const when = [20, 30, 40, 50];
    const s = session(steady(60, 8, spikesAt(when, 40, 'gpu')), {
      gpuTimeline: gpuTimeline(60, (t) => (during(when, 1)(t) ? { usedMiB: 31_500 } : {}))
    });
    const events = run(s);
    expect(new Set(causeIds(events))).toEqual(new Set(['vram']));
    expect(events[0].cause).toMatchObject({ case: 4, fixable: true, confidence: 'high' });
  });

  it('case 4 pins 95 %: the same growth and GPU spike at 94 % is not VRAM, at 96 % it is', () => {
    const when = [20, 30, 40, 50];
    const at = (share: number) =>
      run(session(steady(60, 8, spikesAt(when, 40, 'gpu')), { gpuTimeline: gpuTimeline(60, (t) => (during(when, 1)(t) ? { usedMiB: usedAt(share) } : {})) }));
    expect(causeIds(at(0.94))).toEqual([null, null, null, null]);
    expect(new Set(causeIds(at(0.96)))).toEqual(new Set(['vram']));
  });

  it('case 4 needs the second half of its signature: a card that merely sits at 99 % lets cases 5, 7 and 8 through', () => {
    const full = (seconds: number) => gpuTimeline(seconds, () => ({ usedMiB: usedAt(0.99) }));
    const stalls = session(steady(30, 8, stall([5, 6.5, 11, 12.2, 19, 27])), { gpuTimeline: full(30) });
    expect(new Set(causeIds(run(stalls)))).toEqual(new Set(['engine']));
    expect(report(stalls).verdict).toBe('engine');
    const beat = session(steady(30, 8, stall(marks(6, 28, 2), 30)), { gpuTimeline: full(30) });
    expect(new Set(causeIds(run(beat)))).toEqual(new Set(['periodic']));
    const when = [20, 30, 40, 50];
    const disk = session(steady(60, 8, spikesAt(when, 40)), {
      gpuTimeline: full(60),
      sensorWindow: sensorWindow(60, { '/pdh/physicaldisk/0/queue': (t) => (during(when, 1)(t) ? 12 : 0) })
    });
    expect(new Set(causeIds(run(disk)))).toEqual(new Set(['storage']));
  });

  it('case 4 wants a real rise: 10 MiB of jitter on a full card is not new assets, 500 MiB is', () => {
    const when = [20, 30, 40, 50];
    const at = (riseMiB: number) =>
      run(session(steady(60, 8, spikesAt(when, 40)), { gpuTimeline: gpuTimeline(60, (t) => ({ usedMiB: usedAt(0.97) + (during(when, 1)(t) ? riseMiB : 0) })) }))[0].cause?.id ?? null;
    expect(at(10)).toBeNull();
    expect(at(500)).toBe('vram');
  });

  it('case 4 on growth alone or a GPU spike alone is low confidence, and names a resident Ollama model', () => {
    const when = [20, 30, 40, 50];
    const growth = session(steady(60, 8, spikesAt(when, 40)), { gpuTimeline: gpuTimeline(60, (t) => (during(when, 1)(t) ? { usedMiB: usedAt(0.99) } : {})) });
    expect(run(growth)[0].cause).toMatchObject({ id: 'vram', confidence: 'low' });
    const snapshot = { ollama: [{ name: 'qwen3:30b', sizeBytes: 19_327_352_832, sizeVramBytes: 19_327_352_832 }] } as unknown as StaticSnapshot;
    const spike = session(steady(60, 8, spikesAt(when, 40, 'gpu')), { gpuTimeline: gpuTimeline(60, () => ({ usedMiB: usedAt(0.99) })), snapshot });
    const cause = run(spike)[0].cause;
    expect(cause).toMatchObject({ id: 'vram', confidence: 'low' });
    expect(cause!.evidence).toContain('Ollama held 18.0 GB of it (qwen3:30b)');
  });

  it('case 5: a disk queue spike found by the collector id shape', () => {
    const when = [20, 30, 40, 50];
    const s = session(steady(60, 8, spikesAt(when, 40)), {
      gpuTimeline: gpuTimeline(60),
      sensorWindow: sensorWindow(60, { '/pdh/physicaldisk/0/queue': (t) => (during(when, 1)(t) ? 12 : 0) })
    });
    const events = run(s);
    expect(new Set(causeIds(events))).toEqual(new Set(['storage']));
    expect(events[0].cause).toMatchObject({ case: 5, fixable: true, confidence: 'high' });
  });

  it('concurrent means ±100 ms: a 10 Hz disk sample 90 ms from the frame counts, one 150 ms away does not', () => {
    const frames = steady(60, 8, spikesAt([30], 40));
    const [spike] = detectStutters(frames).events;
    const id = '/pdh/physicaldisk/0/queue';
    const windowWith = (offsetS: number): SensorWindow => {
      const w = sensorWindow(60, { [id]: () => 0 }, 10);
      w.rows.push({ qpc: spike.qpc + Math.round(offsetS * HZ), values: { [id]: 12 } });
      w.rows.sort((a, b) => a.qpc - b.qpc);
      return w;
    };
    const at = (offsetS: number) => classify([spike], session(frames, { sensorWindow: windowWith(offsetS) }))[0].cause?.id ?? null;
    expect(at(0.09)).toBe('storage');
    expect(at(-0.09)).toBe('storage');
    expect(at(0.15)).toBeNull();
    expect(at(-0.15)).toBeNull();
  });

  it('a 2 Hz GPU reading further than 100 ms from the frame is said so in the evidence', () => {
    const shape = (t: number) => (during([30], 1)(t) ? { smMhz: 2400, reasons: 0x40, temperatureC: 84 } : {});
    const frames = steady(60, 8, spikesAt([30.2], 40, 'gpu'));
    const far = run(session(frames, { gpuTimeline: gpuTimeline(60, shape) }))[0].cause!;
    expect(far.id).toBe('thermal');
    expect(far.evidence.at(-1)).toMatch(/^nearest GPU reading 0\.[23] s from the frame$/);
    const near = run(session(frames, { gpuTimeline: gpuTimeline(60, shape, 10) }))[0].cause!;
    expect(near.evidence.some((e) => e.startsWith('nearest GPU reading'))).toBe(false);
  });

  it('case 2 pins the 83 °C target: a clock drop at 82 °C without the bit is not thermal, at 83 °C it is', () => {
    const when = [20, 30, 40, 50];
    const at = (temperatureC: number) =>
      run(session(steady(60, 8, spikesAt(when, 40, 'gpu')), { gpuTimeline: gpuTimeline(60, (t) => (during(when, 1)(t) ? { smMhz: 2400, temperatureC } : {})) }))[0].cause;
    expect(at(82)).toBeNull();
    expect(at(83)).toMatchObject({ id: 'thermal', confidence: 'low' });
  });

  it('case 5: the disk queue is also found by sensor name', () => {
    const when = [20, 30, 40, 50];
    const meta: SensorMeta[] = [{ id: 'q0', hardware: 'd0', hardwareName: '0 C:', hardwareType: 'Storage', name: 'Current Disk Queue Length', sensorType: 'Factor', unit: '' }];
    const s = session(steady(60, 8, spikesAt(when, 40)), {
      sensorWindow: sensorWindow(60, { q0: (t) => (during(when, 1)(t) ? 3 : 0) })
    });
    expect(run(s, { sensorMeta: meta })[0].cause).toMatchObject({ id: 'storage', confidence: 'low' });
    expect(run(s)[0].cause).toBeNull();
  });

  it('case 6: a CPU stall with a hog in the process sample names it; without the sample it is case 8', () => {
    const when = [5, 6.5, 11, 12.2, 19, 27];
    const s = session(steady(30, 8, spikesAt(when, 40, 'cpu')), { gpuTimeline: gpuTimeline(30) });
    const hogs: HogsResult = { seconds: 5, logicalCpus: 32, processes: [{ pid: 7, name: 'ffmpeg.exe', cpuPercent: 30, workingSetMiB: 500 }] };
    const named = run(s, { hogs });
    expect(new Set(causeIds(named))).toEqual(new Set(['background']));
    expect(named[0].cause).toMatchObject({ case: 6, fixable: true, confidence: 'high', process: 'ffmpeg.exe' });
    expect(new Set(causeIds(run(s)))).toEqual(new Set(['engine']));
  });

  it('case 7: stutters on a 2 s beat are the engine\'s own tick and not fixable', () => {
    const when = marks(6, 28, 2);
    const s = session(steady(30, 8, spikesAt(when, 30, 'cpu')), { gpuTimeline: gpuTimeline(30) });
    const events = run(s);
    expect(events).toHaveLength(when.length);
    expect(new Set(causeIds(events))).toEqual(new Set(['periodic']));
    expect(events[0].cause).toMatchObject({ case: 7, fixable: false, confidence: 'high' });
    expect(events[0].cause!.evidence[0]).toMatch(/every 2\.0\d s/);
  });

  it('case 8: an irregular CPU stall with the GPU waiting is an engine stall, not fixable', () => {
    const when = [5, 6.5, 11, 12.2, 19, 27];
    const s = session(steady(30, 8, spikesAt(when, 40, 'cpu')), { gpuTimeline: gpuTimeline(30) });
    const events = run(s);
    expect(new Set(causeIds(events))).toEqual(new Set(['engine']));
    expect(events[0].cause).toMatchObject({ case: 8, fixable: false, confidence: 'high' });
  });

  it('case 8 also takes a CPU stall with GPU work merely normal, at low confidence', () => {
    const when = [5, 6.5, 11, 12.2, 19, 27];
    const frames: FrameRow[] = steady(30, 8, spikesAt(when, 40, 'cpu')).map((f) => (f.msBetweenPresents === 40 ? { ...f, msGpuWait: 5 } : f));
    const events = run(session(frames, { gpuTimeline: gpuTimeline(30) }));
    expect(new Set(causeIds(events))).toEqual(new Set(['engine']));
    expect(events[0].cause).toMatchObject({ case: 8, confidence: 'low' });
    expect(events[0].cause!.evidence).toContain('GPU work stayed normal');
  });

  it('case 6 reads the hogs sample the session carries', () => {
    const hogs: HogsResult = { seconds: 5, logicalCpus: 32, processes: [{ pid: 7, name: 'ffmpeg.exe', cpuPercent: 30, workingSetMiB: 500 }] };
    const s = { ...session(steady(30, 8, spikesAt([5, 6.5, 11, 12.2, 19, 27], 40, 'cpu')), { gpuTimeline: gpuTimeline(30) }), hogs };
    expect(report(s).causes[0]).toMatchObject({ id: 'background' });
  });

  it('case 9: frames alternating 6 and 22 ms with nothing under strain is pacing', () => {
    let n = 0;
    const s = session(steady(30, 8, (t) => (t >= 15 && n < 40 ? { ms: ++n % 2 ? 22 : 6 } : null)), { gpuTimeline: gpuTimeline(30) });
    const events = run(s);
    expect(events).toHaveLength(20);
    expect(new Set(causeIds(events))).toEqual(new Set(['pacing']));
    expect(events[0].cause).toMatchObject({ case: 9, fixable: true, confidence: 'high' });
  });

  it('leaves a lone unexplained spike unclassified', () => {
    const s = session(steady(60, 8, spikesAt([30], 40)), { gpuTimeline: gpuTimeline(60) });
    expect(causeIds(run(s))).toEqual([null]);
  });
});

describe('buildReport', () => {
  it('says there is nothing worth fixing when the capture is clean', () => {
    const s = session(steady(120, 8, spikesAt([30, 90], 40)));
    const r = report(s);
    expect(r.verdict).toBe('fine');
    expect(r.headline).toBe('No stutter worth fixing');
    expect(r.stutterCount).toBe(2);
    expect(r.measurements['Frames analysed']).toBe(s.frames.length - WARMUP_FRAMES);
  });

  it('says the capture was too short before the level load is over', () => {
    const r = report(session(steady(2, 8)));
    expect(r.verdict).toBe('short');
    expect(r.headline).toMatch(/Not enough frames/);
    expect(r.causes).toEqual([]);
  });

  it('does not judge the rate inside the first minute: one hitch in 17 s is fine, and so are three small ones', () => {
    expect(report(session(steady(17, 8, spikesAt([10], 40)))).verdict).toBe('fine');
    const three = report(session(steady(17, 8, spikesAt([8, 10, 12], 17))));
    expect(three.percentTimeLost).toBeLessThan(0.5);
    expect(three.verdict).toBe('fine');
    expect(three.headline).toBe('No stutter worth fixing');
  });

  it('pins the worth-fixing line at 2 a minute past the first minute, and at 0.5 % lost at any length', () => {
    expect(report(session(steady(180, 8, spikesAt(marks(30, 180, 30), 17)))).verdict).toBe('fine');
    const seven = report(session(steady(180, 8, spikesAt([20, 35, 70, 80, 120, 130, 170], 17))));
    expect(seven.percentTimeLost).toBeLessThan(0.5);
    expect(seven.verdict).toBe('unclear');
    expect(seven.headline).toMatch(/does not show a clear cause/);
    const lone = report(session(steady(20, 8, spikesAt([10], 200))));
    expect(lone.stutterCount).toBe(1);
    expect(lone.percentTimeLost).toBeGreaterThan(0.5);
    expect(lone.verdict).toBe('unclear');
  });

  it('is fixable, with shares by time lost, when every cause has an action', () => {
    const when = marks(20, 60, 3);
    const s = session(steady(60, 8, spikesAt(when, 40, 'gpu')), {
      gpuTimeline: gpuTimeline(60, (t) => (during(when, 1)(t) ? { smMhz: 2400, reasons: 0x40, temperatureC: 84 } : {}))
    });
    const r = report(s);
    expect(r.verdict).toBe('fixable');
    expect(r.headline).toBe('Stuttering found — and you can do something about it');
    expect(r.causes).toHaveLength(1);
    expect(r.causes[0]).toMatchObject({ id: 'thermal', share: 1, fixable: true, confidence: 'high' });
    expect(r.causes[0].action).toMatch(/fan curve/);
    expect(r.measurements['GPU max temperature (°C)']).toBe(84);
  });

  it('says plainly that nothing on your end changes an engine tick', () => {
    const s = session(steady(30, 8, spikesAt(marks(6, 28, 2), 30, 'cpu')), { gpuTimeline: gpuTimeline(30) });
    const r = report(s);
    expect(r.verdict).toBe('engine');
    expect(r.headline).toBe('Stuttering found — nothing on your end changes this');
    expect(r.causes[0]).toMatchObject({ id: 'periodic', fixable: false });
    expect(r.causes[0].text).toMatch(/every 2\.0\d s/);
    expect(r.causes[0].action).toMatch(/^No setting on your end changes this/);
  });

  it('is mixed when the game and the PC each own a share', () => {
    const thermalAt = [10, 14, 18, 22];
    const stallAt = [30, 31.5, 36, 37.2, 45, 53];
    const thermal = spikesAt(thermalAt, 40, 'gpu');
    const stall = spikesAt(stallAt, 40, 'cpu');
    const frames = steady(60, 8, (t) => thermal(t) ?? stall(t));
    const s = session(frames, {
      gpuTimeline: gpuTimeline(60, (t) => (during(thermalAt, 1)(t) ? { smMhz: 2400, reasons: 0x40, temperatureC: 84 } : {}))
    });
    const r = report(s);
    expect(r.verdict).toBe('mixed');
    expect(r.causes.map((c) => c.id).sort()).toEqual(['engine', 'thermal']);
    expect(r.causes.reduce((a, c) => a + c.share, 0)).toBeCloseTo(1, 9);
    expect(r.causes.find((c) => c.id === 'engine')!.share).toBeCloseTo(0.6, 9);
  });

  it('names the background process in the wording', () => {
    const s = session(steady(30, 8, spikesAt([5, 6.5, 11, 12.2, 19, 27], 40, 'cpu')));
    const hogs: HogsResult = { seconds: 5, logicalCpus: 32, processes: [{ pid: 7, name: 'ffmpeg.exe', cpuPercent: 30, workingSetMiB: 500 }] };
    const r = report(s, { hogs });
    expect(r.causes[0].text).toContain('ffmpeg.exe');
    expect(r.causes[0].action).toContain('Close ffmpeg.exe');
  });

  it('carries the bound verdict and the raw numbers', () => {
    const s = session(steady(60, 8, spikesAt([30], 40)));
    const d = detectStutters(s.frames);
    const r = buildReport(s, { ...d, events: classify(d.events, s) }, judgeBound(s));
    expect(r.bound.limiter).toBe('unknown');
    expect(r.measurements['Typical frame (ms)']).toBe(8);
    expect(r.measurements['Average FPS']).toBeCloseTo(125, 0);
    expect(r.events).toHaveLength(1);
  });
});
