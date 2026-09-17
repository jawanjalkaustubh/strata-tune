import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FlightLine, TuneCandidate, TuneDeltas, TuneRun, TuneStatus } from '../src/collector-types';
import { SensorIndex } from '../src/components/monitor/sensors';
import { Ring } from '../src/components/monitor/history';
import { bisectOf, notRising, parseFlight, refusalOf, toolIn } from '../src/components/tune/wire';
import { TuneWarning } from '../src/components/tune/TuneWarning';
import { hardwareRiskSection } from '../src/components/tune/disclaimer';
import { gates } from '../src/components/tune/Controls';
import { StateStrip } from '../src/components/tune/StateStrip';
import { Ladder } from '../src/components/tune/Ladder';
import { LiveMonitor } from '../src/components/tune/LiveMonitor';
import { Results } from '../src/components/tune/Results';
import { FlightRecorder } from '../src/components/tune/FlightRecorder';
import { devbox, devboxMeta, devboxTick } from './fixtures';

// The pieces render outside Electron (and outside a browser): no window.strata, so the gates' "not inside Electron" path is the one under test.
vi.mock('../src/api', () => ({ api: undefined, inElectron: false, ipcErrorMessage: (e: unknown) => String(e) }));

/** The renderer's localStorage, enough of it for useSettings inside LiveMonitor. */
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k)
};

const deltas = (coreMhz: number, memMhz = 0): TuneDeltas => ({ coreKhz: coreMhz * 1000, memKhz: memMhz * 1000, coreMhz, memMhz });
const ZERO = deltas(0);

const rung = (coreMhz: number, verdict: TuneCandidate['verdict'], stage: number | null = null): TuneCandidate => ({
  deltas: deltas(coreMhz), verdict, stage, failedPattern: stage ? 'heavy' : null, bandwidthGBs: 1712, throttledFraction: 0, note: stage ? 'hash mismatch in dispatch 412' : 'held'
});

/** A finished core hunt: three rungs held, the fourth tripped at stage 1, then the bisect closed on +90. */
const RUN: TuneRun = {
  id: 'r1', kind: 'core', state: 'done', startedAt: '2026-09-16T10:00:00Z', elapsedS: 612, phase: 'restore', candidate: null, stage: null, pattern: null,
  patternElapsedS: 0, patternSeconds: 0, deviceLostCount: 0, errorCount: 1, bandwidthGBs: 1712, bestBandwidthGBs: 1712, validity: 'ok', lastEvent: 'baseline restored',
  candidates: [rung(30, 'stable'), rung(60, 'stable'), rung(90, 'stable'), rung(120, 'unstable', 1)],
  result: null, error: null
};

const STATUS: TuneStatus = {
  enabled: true, state: 'KNOWN_GOOD', baseline: ZERO, candidate: null, appliedAt: null, lastCleanShutdown: '2026-09-16T08:00:00Z', reverted: null,
  result: { kind: 'core', deltas: deltas(90), baseline: ZERO, bandwidthGBs: 1712, referenceHash: 'abc', confidence: 'high', validated: false, foundAt: '2026-09-16T10:12:00Z', promoted: false, referenceSmMhz: 3210, referenceMemMhz: 1979, throttledFraction: null },
  history: [{ at: '2026-09-16T10:12:00Z', state: 'KNOWN_GOOD', candidate: null, note: 'hunt done: core +90 held, +120 tripped at stage 1' }],
  nvapi: { available: true, reason: null, deltas: ZERO, range: null },
  run: null, revertTaskRegistered: true, flightAvailable: false, stateFile: 'C:\\ProgramData\\Strata Tune\\tune-state.json', revertTaskProblem: null, problem: null
};

const HUNTING: TuneRun = { ...RUN, state: 'running', phase: 'bisect', candidate: deltas(105), pattern: 'heavy', patternElapsedS: 41, patternSeconds: 90, elapsedS: 83, lastEvent: 'candidate +105 applied' };

const connected = { status: 'connected' as const, message: 'Connected' };

describe('tune wire helpers', () => {
  it('the bisect window is the highest rung that held and the lowest that tripped, only while bisecting', () => {
    expect(bisectOf(HUNTING, 'core')).toEqual({ lo: 90, hi: 120 });
    expect(bisectOf(RUN, 'core')).toBeNull();
  });

  it("a memory step that held but did not raise the bandwidth is the sweep's tripped rung", () => {
    const step = (memMhz: number, bw: number): TuneCandidate => ({ ...rung(0, 'stable'), deltas: deltas(0, memMhz), bandwidthGBs: bw });
    const sweep: TuneRun = { ...HUNTING, kind: 'memory', phase: 'bisect', bestBandwidthGBs: 1750, candidate: deltas(0, 150), candidates: [step(0, 1700), step(100, 1750), step(200, 1745), step(300, 1748)] };
    expect(notRising(sweep, sweep.candidates[2])).toBe(true);
    expect(notRising(sweep, sweep.candidates[1])).toBe(false);
    expect(bisectOf(sweep, 'memory')).toEqual({ lo: 100, hi: 200 });
    expect(bisectOf({ ...sweep, kind: 'core' }, 'core')).toBeNull();
  });

  it('a 409 refusal is read out of the client message, and the vendor tool it names is found', () => {
    const refusal = refusalOf('POST /tune/start answered 409 {"error":"GPU Tweak III is running; its profile timers would fight the hunt"}');
    expect(refusal).toBe('GPU Tweak III is running; its profile timers would fight the hunt');
    expect(toolIn(refusal)).toBe('GPU Tweak III');
    expect(toolIn('Ollama has qwen3 loaded on the GPU')).toBeNull();
  });

  it('the flight file is NDJSON, a cut-off last line dropped', () => {
    const lines = parseFlight('{"kind":"event","at":"2026-09-16T09:40:30Z","text":"candidate +150 applied","candidate":null,"stage":null,"pattern":null}\n{"kind":"sample","at":"2026-09-16T09:40:31Z","qpc":1,"gpu":null,"cpu":null,"sensors":{}}\n{"kind":"sam');
    expect(lines.map((l) => l.kind)).toEqual(['event', 'sample']);
  });
});

describe('tune gates', () => {
  it('everything is disabled with the one reason when there is no collector', () => {
    const g = gates(false, { status: 'idle', message: 'Not running inside Electron' }, null, null);
    expect(new Set(Object.values(g))).toEqual(new Set(['Not running inside Electron']));
  });

  it('a found result unlocks Validate but not Keep; a running test leaves Stop and Revert; a kept result blocks a new hunt', () => {
    const g = gates(true, connected, STATUS, null);
    expect(g.find).toBeNull();
    expect(g.validate).toBeNull();
    expect(g.keep).toBe('Validate the result first');
    expect(g.revert).toBe("Nothing of Tune's is on the card");
    expect(gates(true, connected, STATUS, HUNTING)).toMatchObject({ find: 'A test is running', stop: null, revert: null });
    const kept = gates(true, connected, { ...STATUS, state: 'VALIDATING', candidate: deltas(90), result: { ...STATUS.result!, validated: true } }, null);
    expect(kept.find).toContain('kept result');
    expect(kept.revert).toBeNull();
  });
});

function render(status: TuneStatus, run: TuneRun | null, tick = devboxTick()) {
  const index = new SensorIndex(devboxMeta());
  const ring = new Ring();
  for (let i = 0; i < 10; i++) ring.push({ ...tick, qpc: tick.qpc + i * 5_000_000 });
  const g = gates(true, connected, status, run);
  return {
    strip: renderToStaticMarkup(<StateStrip status={status} reason={null} refusal={null} />),
    ladder: renderToStaticMarkup(<Ladder run={run} />),
    monitor: renderToStaticMarkup(<LiveMonitor index={index} tick={tick} ring={ring} snapshot={devbox()} status={status} run={run} />),
    results: renderToStaticMarkup(<Results status={status} export={null} gates={g} busy={null} onKeep={() => undefined} onRevert={() => undefined} />)
  };
}

describe('Tune page pieces render the dev box', () => {
  it('state strip: the stage pill, the baseline read from the driver, no candidate row', () => {
    const { strip } = render(STATUS, null);
    expect(strip).toContain('KNOWN GOOD');
    expect(strip).toContain('read from the driver');
    expect(strip).not.toContain('On the card');
  });

  it('ladder: three emerald ticks, one red with its stage in the header, the bisect band while bisecting', () => {
    const { ladder } = render(STATUS, HUNTING);
    // Ticks only: the key beneath the strip carries one swatch of each colour.
    expect((ladder.match(/-translate-x-1\/2 bg-emerald-500/g) ?? []).length).toBe(3);
    expect((ladder.match(/-translate-x-1\/2 bg-rose-500/g) ?? []).length).toBe(1);
    expect(ladder).toContain('tripped at +120 · stage 1 · silent error');
    expect(ladder).toContain('Bisecting between +90 and +120 MHz');
    expect(ladder).toContain('under test (heavy)');
  });

  it('live monitor: the shared bars, the perf-limit pills, the validity pill idle when no test runs', () => {
    const { monitor } = render(STATUS, null);
    expect(monitor).toContain('bar-row');
    expect(monitor).toContain('SM clock');
    expect(monitor).toContain('Perf limit');
    expect(monitor).toContain('no test');
    expect(monitor).toContain('#76B900');
    expect(monitor).toContain('No test running.');
  });

  it("validity turns red from the live bits during a hunt, and from the collector's verdict", () => {
    const tick = devboxTick();
    tick.gpu[0].clocksEventReasons = { raw: 0x4, names: ['SwPowerCap'] };
    expect(render(STATUS, HUNTING, tick).monitor).toContain('invalid: throttling during the ceiling hunt');
    expect(render(STATUS, { ...HUNTING, validity: 'throttled' }).monitor).toContain('invalid: throttled during the run');
    const hunting = render(STATUS, HUNTING).monitor;
    expect(hunting).toContain('+105 MHz offset');
    expect(hunting).toContain('bisect · rung 5');
  });

  it('results: the found values with their baseline, Keep waits for validation, the history line, no export box without one', () => {
    const { results } = render(STATUS, null);
    expect(results).toContain('core +90 · mem +0 MHz');
    expect(results).toContain('not yet validated');
    expect(results).toContain(' Keep</button>');
    expect(results).not.toContain('Keep (validate)');
    expect(results).toContain('Validate the result first');
    const promoted = render({ ...STATUS, result: { ...STATUS.result!, validated: true, promoted: true } }, null).results;
    expect(promoted).toContain('known-good');
    expect(results).toContain('hunt done: core +90 held');
    expect(results).not.toContain('Export for Afterburner');
  });

  it("the warning modal carries the disclaimer's hardware-risk section verbatim and the warranty sentence (plan 27a)", () => {
    const html = renderToStaticMarkup(<TuneWarning isOpen onAccept={() => undefined} onClose={() => undefined} />);
    const section = hardwareRiskSection();
    expect(section.length).toBeGreaterThan(2);
    expect(section.some((b) => b.text.includes('may void your hardware warranty'))).toBe(true);
    expect(html).toContain('may void your hardware warranty');
    expect(html).toContain('You do this at your own risk.');
    expect(html).toContain('may void the vendor');
    expect(html).toContain('records this acknowledgement');
    expect(html).toContain('until the next reboot');
    // The disclaimer text is not retyped: a section pulled from a copy with a different heading is empty.
    expect(hardwareRiskSection('# other\n\n## 3. Something else\n\ntext')).toEqual([]);
  });

  it('state strip: a refused logon task shows its reason; a blocking problem reads in the gates', () => {
    const { strip } = render({ ...STATUS, revertTaskRegistered: false, revertTaskProblem: 'the logon revert task is refused: Authenticated Users may write D:\\dev' }, null);
    expect(strip).toContain('revert-at-logon task not registered');
    expect(strip).toContain('Authenticated Users may write');
    const g = gates(true, connected, { ...STATUS, problem: 'the state folder is not administrator-only' }, null);
    expect(g.find).toContain('the state folder is not administrator-only');
  });

  it('flight recorder: the banner names the values, the chart draws the samples, throttle marks and ladder events', () => {
    const tick = devboxTick();
    const lines: FlightLine[] = [];
    for (let i = 0; i < 30; i++) {
      const gpu = { ...tick.gpu[0], clocks: { smMhz: 3200 + i, memMhz: 15800 }, clocksEventReasons: { raw: i > 25 ? 4 : 0, names: [] } };
      lines.push({ kind: 'sample', at: new Date(Date.UTC(2026, 8, 16, 9, 41, i)).toISOString(), qpc: i, gpu, cpu: null, sensors: {} });
    }
    lines.push({ kind: 'event', at: new Date(Date.UTC(2026, 8, 16, 9, 41, 3)).toISOString(), text: 'candidate +150 applied', candidate: deltas(150), stage: null, pattern: 'heavy' });
    const reverted = { candidate: deltas(150), baseline: ZERO, at: '2026-09-16 09:41', reason: 'hard hang (stage 4)' };
    const html = renderToStaticMarkup(<FlightRecorder reverted={reverted} flight={lines} />);
    expect(html).toContain('hard-hung at core +150 / memory +0 MHz');
    expect(html).toContain('<path');
    expect((html.match(/<rect/g) ?? []).length).toBe(5);
    expect(html).toContain('candidate +150 applied');
  });
});
