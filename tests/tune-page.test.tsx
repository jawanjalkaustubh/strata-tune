import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FlightLine, TuneCandidate, TuneDeltas, TuneExport, TuneResult, TuneRun, TuneStatus } from '../src/collector-types';
import type { DeviceClass } from '../src/analysis/tune';
import { deviceClass, DEVICE_CLASS_LABEL, isScoredRun } from '../src/analysis/tune';
import { SensorIndex } from '../src/components/monitor/sensors';
import { Ring } from '../src/components/monitor/history';
import { additivityOf, parseFlight, refusalOf, stopOutcome, toolIn } from '../src/components/tune/wire';
import { TuneWarning } from '../src/components/tune/TuneWarning';
import { hardwareRiskSection } from '../src/components/tune/disclaimer';
import { HEADROOM_NEEDS_NVIDIA, HEADROOM_OFF, HEADROOM_TAGLINE, WARNING_BODY, WARNING_LAPTOP_LINE, WARNING_RISK, WRITES_ROUTE_LINE, WRITES_SENTENCE } from '../src/components/tune/text';
import { Controls, gates } from '../src/components/tune/Controls';
import { StateStrip } from '../src/components/tune/StateStrip';
import { ScoreClimb } from '../src/components/tune/ScoreClimb';
import { LiveMonitor } from '../src/components/tune/LiveMonitor';
import { Results, textOf } from '../src/components/tune/Results';
import { FlightRecorder } from '../src/components/tune/FlightRecorder';
import { VendorForm, vendorCheck } from '../src/components/tune/VendorForm';
import { updateSettings } from '../src/components/useSettings';
import { dimmVoltageOf, Headroom, HeadroomUnavailable, powerCapSentence } from '../src/components/tune/Headroom';
import { devbox, devboxMeta, devboxTick } from './fixtures';

// The pieces render outside Electron (and outside a browser): no window.strata, so the gates' "not inside Electron" path is the one under test.
vi.mock('../src/api', () => ({ api: undefined, inElectron: false, ipcErrorMessage: (e: unknown) => String(e) }));

/** The renderer's localStorage, enough of it for useSettings inside the pieces. */
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k)
};

interface ClassFixture {
  class: DeviceClass;
  snapshot: Parameters<typeof deviceClass>[0];
  tune: { status: TuneStatus; export: TuneExport | null };
}

const dir = join(__dirname, 'fixtures', 'classes');
const fixtures: ClassFixture[] = readdirSync(dir)
  .filter((f) => f.endsWith('.tune.json'))
  .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as ClassFixture);
const high = fixtures.find((f) => f.class === 'high-end-pc')!;

/** This box's finished hunt on top of its GPU Tweak tune: the fixture is the truth the page renders. */
const STATUS: TuneStatus = high.tune.status;
const RESULT: TuneResult = STATUS.result!;
const EXPORT: TuneExport = high.tune.export!;

const deltas = (coreMhz: number, memMhz = 0): TuneDeltas => ({ coreKhz: coreMhz * 1000, memKhz: memMhz * 1000, coreMhz, memMhz });

/** The same hunt mid-way: the memory ladder done, the core ladder on its third rung. */
const HUNTING: TuneRun = {
  id: 'r1', kind: 'hunt', state: 'running', startedAt: '2026-09-17T06:20:00Z', elapsedS: 540, phase: 'climb', ladder: 'core', candidate: deltas(364, 2036), stage: null, pattern: 'variable',
  patternElapsedS: 12, patternSeconds: 30, deviceLostCount: 0, errorCount: 0, bandwidthGBs: 1441.2, bestBandwidthGBs: 1441.2, baselineHeld: RESULT.baselineHeld, validity: 'ok', lastEvent: 'core +45 applied',
  candidates: RESULT.rungs.slice(0, 7), result: null, error: null, repeat: 0, asFound: RESULT.asFound
};

const connected = { status: 'connected' as const, message: 'Connected' };

/** React escapes apostrophes in text; the strings under test are compared the way they render. */
const esc = (text: string) => text.replace(/'/g, '&#x27;');

/** Every string present, each after the one before it. */
function inOrder(html: string, strings: string[]) {
  let pos = 0;
  for (const s of strings) {
    const i = html.indexOf(esc(s), pos);
    expect(i, `${s} after position ${pos}`).toBeGreaterThanOrEqual(0);
    pos = i + s.length;
  }
}

describe('tune wire helpers', () => {
  it('a 409 refusal is read out of the client message, and the vendor tool it names is found', () => {
    const refusal = refusalOf('POST /tune/start answered 409 {"error":"GPU Tweak III is changing the memory clock under the test"}');
    expect(refusal).toBe('GPU Tweak III is changing the memory clock under the test');
    expect(toolIn(refusal)).toBe('GPU Tweak III');
    expect(toolIn('Ollama has qwen3 loaded on the GPU')).toBeNull();
  });

  it('the flight file is NDJSON, a cut-off last line dropped', () => {
    const lines = parseFlight('{"kind":"event","at":"2026-09-16T09:40:30Z","text":"candidate +150 applied","candidate":null,"stage":null,"pattern":null}\n{"kind":"sample","at":"2026-09-16T09:40:31Z","qpc":1,"gpu":null,"cpu":null,"sensors":{}}\n{"kind":"sam');
    expect(lines.map((l) => l.kind)).toEqual(['event', 'sample']);
  });

  it('the additivity check is read back per ladder: the climb against the vendor rung it sat on (or the card as found), rung by rung until decided', () => {
    const adds = additivityOf(RESULT);
    expect(adds).toEqual([
      { ladder: 'memory', passed: true, text: '16052 vs 16037 your tune through our route (+15 written)' },
      { ladder: 'core', passed: true, text: '3341 vs 3326 your tune through our route (+15 written)' }
    ]);
    // Run bb09b0a0455c: no vendor rung (our route already held the tune), the first core rung half a bin up, the second decides.
    // The fixture's as-found throughput is what the rungs are judged against on the cap, so it is pinned flat here.
    const flat = RESULT.asFound!.score!.throughputGsps;
    const half = { ...RESULT.rungs[5], topSmMhz: 3337, throughputGsps: flat, meanSmMhz: null };
    const second = { ...RESULT.rungs[6], topSmMhz: 3352, throughputGsps: flat, meanSmMhz: null };
    const noVendor = { ...RESULT, rungs: [half, second], asFound: { ...RESULT.asFound!, topSmMhz: 3330 } };
    expect(additivityOf(noVendor)[0]).toEqual({ ladder: 'core', passed: true, text: '3352 vs 3330 as found (+30 written)' });
    expect(additivityOf({ ...noVendor, rungs: [half] })[0]).toEqual({ ladder: 'core', passed: false, text: 'not yet shown: 3337 vs 3330 as found (+15 written, within a bin); a second rung decides' });
    // Workflow 13c, tonight's numbers: the top read 3337 both times, but the throughput rose 1 % (12,536 → 12,661 points): the offset counts on the cap.
    const onCap = additivityOf({ ...noVendor, rungs: [{ ...half, throughputGsps: flat * 1.01 }] })[0];
    expect(onCap.passed).toBe(true);
    expect(onCap.text).toContain('the offset counts on the cap');
    const failed = additivityOf({ ...RESULT, stops: [{ ladder: 'memory', reason: 'additivity', offsetMhz: 15, stage: null, note: 'the driver is not adding our offset on top of your tune: it replaced it' }] });
    expect(failed[0]).toEqual({ ladder: 'memory', passed: false, text: 'the driver is not adding our offset on top of your tune: it replaced it' });
    // A top-of-table stop is read as the verdict it is: not passed, the collector's own sentence.
    const table = additivityOf({ ...RESULT, stops: [{ ladder: 'core', reason: 'top-of-table', offsetMhz: 0, stage: null, note: 'the card already runs at the top of its clock table (3337 MHz); no core headroom above it through offsets, certified +0 core' }] });
    expect(table.find((a) => a.ladder === 'core')).toEqual({ ladder: 'core', passed: false, text: 'the card already runs at the top of its clock table (3337 MHz); no core headroom above it through offsets, certified +0 core' });
  });

  it('Stop shows the restore outcome: back as found at IDLE, still on the card at PENDING', () => {
    const stopped: TuneRun = { ...HUNTING, state: 'stopped', lastEvent: 'restore baseline ok on attempt 1: applied core 319000 / memory 2036000 kHz; driver reads back the same' };
    expect(stopOutcome(STATUS, stopped)).toEqual({ tone: 'ok', text: 'Stopped; the card is back as it was found (restore baseline ok on attempt 1: applied core 319000 / memory 2036000 kHz; driver reads back the same).' });
    expect(stopOutcome({ ...STATUS, state: 'PENDING' }, { ...stopped, error: 'NvAPI_GPU_SetPstates20 refused' })!.text).toContain('not back on the card: NvAPI_GPU_SetPstates20 refused');
    expect(stopOutcome(STATUS, HUNTING)).toBeNull();
  });
});

describe('tune gates', () => {
  it('everything is disabled with the one reason when there is no collector', () => {
    const g = gates(false, { status: 'idle', message: 'Not running inside Electron' }, null, null);
    expect(new Set(Object.values(g))).toEqual(new Set(['Not running inside Electron']));
  });

  it('a result leaves Find open and Revert closed; a running hunt leaves Stop alone (Revert mid-run would write under the rung); PENDING blocks a new hunt; no NVAPI names why', () => {
    expect(gates(true, connected, STATUS, null)).toEqual({ find: null, stop: 'No hunt is running', revert: "Nothing of Tune's is on the card" });
    expect(gates(true, connected, STATUS, HUNTING)).toEqual({ find: 'A hunt is running', stop: null, revert: 'A hunt is running: Stop it first' });
    expect(gates(true, connected, { ...STATUS, state: 'PENDING', candidate: deltas(364, 2036) }, null).find).toContain('revert it first');
    const mid = fixtures.find((f) => f.class === 'mid-range-pc')!;
    expect(gates(true, connected, mid.tune.status, null).find).toContain('NVIDIA cards only');
  });
});

function render(status: TuneStatus, run: TuneRun | null, tick = devboxTick()) {
  const index = new SensorIndex(devboxMeta());
  const ring = new Ring();
  for (let i = 0; i < 10; i++) ring.push({ ...tick, qpc: tick.qpc + i * 5_000_000 });
  const g = gates(true, connected, status, run);
  const r = status.result;
  return {
    strip: renderToStaticMarkup(<StateStrip status={status} reason={null} refusal={null} />),
    climb: renderToStaticMarkup(<ScoreClimb run={run} rungs={r?.rungs ?? []} asFound={run?.asFound ?? r?.asFound ?? null} official={r?.official ?? null} baseline={status.baseline} />),
    monitor: renderToStaticMarkup(<LiveMonitor index={index} tick={tick} ring={ring} snapshot={devbox()} status={status} run={run} />),
    results: renderToStaticMarkup(<Results status={status} export={high.tune.export} gates={g} busy={null} deviceClass="high-end-pc" gpuName="NVIDIA GeForce RTX 5090" onRevert={() => undefined} onSave={() => undefined} />),
    controls: renderToStaticMarkup(<Controls gates={g} busy={null} refusal={null} estimateMinutes={17} onFind={() => undefined} onStop={() => undefined} />)
  };
}

describe('Tune page pieces render the dev box on top of its vendor tune', () => {
  it('state strip: IDLE, the baseline is the vendor tune through our route, no rung on the card', () => {
    const { strip } = render(STATUS, null);
    expect(strip).toContain('>IDLE<');
    expect(strip).toContain('core +319 · mem +2036 MHz');
    expect(strip).toContain('your vendor tune through our route');
    expect(strip).not.toContain('On the card');
    expect(strip).not.toContain('logon');
  });

  it('score climb: the as-found score, every rung as "+15 → 11,704", the tripped rung with its stage, the official run last', () => {
    const { climb } = render(STATUS, { ...HUNTING, state: 'done', phase: 'restore', candidate: null, candidates: RESULT.rungs, result: RESULT });
    expect(climb).toContain('as found');
    expect(climb).toContain('11,701');
    expect(climb).toContain('>+15<');
    expect(climb).toContain('>vendor<');
    expect(climb).toContain('11,704');
    expect(climb).toContain('silent error, stopped');
    expect(climb).toContain('>official<');
    expect(climb).toContain('11,812');
    // Each rung's gain against as found is a small line under its points, the certified rung is outlined, the official run says its gain over as found.
    expect(climb).toContain('+0.0 %');
    expect(climb).toContain('+0.9 % over as found');
    expect((climb.match(/ring-1 ring-emerald-400\/70/g) ?? []).length).toBe(2);
    // The rung under test is hollow with its half and clock.
    const live = render(STATUS, HUNTING).climb;
    expect(live).toContain('variable 00:12 / 00:30');
    expect(live).toContain('border-dashed');
    expect(live).toContain('climbing');
  });

  it('score climb: a result the earlier collector wrote lists the as-found and official runs among the rungs too; they are drawn once, never as "−2036"', () => {
    // Run 154463d9b2f1 on the dev box (2026-09-17): rungs[0] was the as-found card at 0 / 0 under a +2036 baseline.
    const asFoundRung: TuneCandidate = { ladder: 'memory', deltas: RESULT.asFound!.deltas, verdict: RESULT.asFound!.verdict, stage: null, failedPattern: null, held: RESULT.asFound!.held, topSmMhz: RESULT.asFound!.topSmMhz, throughputGsps: null, bandwidthGBs: null, throttledFraction: 0.98, note: RESULT.asFound!.note, score: RESULT.asFound!.score };
    const officialRung: TuneCandidate = { ...asFoundRung, deltas: RESULT.official!.deltas, verdict: RESULT.official!.verdict, held: RESULT.official!.held, note: RESULT.official!.note, score: RESULT.official!.score };
    const old: TuneResult = { ...RESULT, rungs: [asFoundRung, ...RESULT.rungs, officialRung] };
    const climb = renderToStaticMarkup(<ScoreClimb run={null} rungs={old.rungs} asFound={old.asFound} official={old.official} baseline={STATUS.baseline} />);
    expect(climb).not.toContain('−2036');
    expect(climb.match(/>as found</g)).toHaveLength(1);
    expect(climb.match(/>official</g)).toHaveLength(1);
    expect(climb.match(/>\+45</g)).toHaveLength(2); // the memory rung at +45 and the core rung at +45, not the official pair again
    expect(isScoredRun(asFoundRung, old.asFound)).toBe(true);
    expect(isScoredRun(RESULT.rungs[1], old.asFound)).toBe(false);
  });

  it('live monitor: the shared bars, the perf-limit pills, the validity pill idle when no test runs', () => {
    const { monitor } = render(STATUS, null);
    expect(monitor).toContain('bar-row');
    expect(monitor).toContain('SM clock');
    expect(monitor).toContain('Perf limit');
    expect(monitor).toContain('#76B900');
    expect(monitor).toContain('No test running.');
  });

  it('live monitor: the power cap is named, never invalid; a thermal bit or the collector verdict of one is (plan 16, the 600 W budget)', () => {
    const capped = devboxTick();
    capped.gpu[0].clocksEventReasons = { raw: 0x4, names: ['SwPowerCap'] };
    const core: TuneRun = { ...HUNTING, kind: 'core' };
    // Workflow 13d: the power cap reads neutral, heat and the board's brake amber and named, never "invalid".
    const onCap = render(STATUS, core, capped).monitor;
    expect(onCap).toContain('on the power cap · normal');
    expect(onCap).not.toMatch(/invalid/i);
    const hot = devboxTick();
    hot.gpu[0].clocksEventReasons = { raw: 0x4 | 0x40, names: ['SwPowerCap', 'HwThermalSlowdown'] };
    expect(render(STATUS, core, hot).monitor).toContain('thermal limit — the cooler, not the clock');
    const brake = devboxTick();
    brake.gpu[0].clocksEventReasons = { raw: 0x80, names: ['HwPowerBrakeSlowdown'] };
    expect(render(STATUS, core, brake).monitor).toContain('power brake — the board, not the clock');
    expect(render(STATUS, { ...HUNTING, validity: 'throttled' }, capped).monitor).toContain('thermal limit during this rung — the cooler, not the clock');
    expect(render(STATUS, HUNTING, devboxTick()).monitor).toContain('>clean<');
    for (const html of [onCap, render(STATUS, core, hot).monitor]) expect(html).not.toMatch(/invalid|throttl/i);
  });

  it('results lead with the score line, then the value set labelled by what the user does with it, the left sentence, the checks, the truth line and the table', () => {
    const { results } = render(STATUS, null);
    // The whole tune to type comes first and largest; the slider-unit step and our NVML pair follow; the sentence says the tune now holds through our route.
    inOrder(results, ['11,812', '+0.9 % over your current tune', '+18.1 % over a reference 5090', 'high-end PC', 'Confidence', 'Type into GPU Tweak / Afterburner', 'core +364 · memory +4192', 'On top of your tune (slider units)', 'core +45 · memory +120', 'Certified on top (NVML MHz)', 'core +45 · mem +60 MHz', "your tune was put back through the driver's P0 offsets (core +319 / memory +2036 NVML MHz), so press Apply in the vendor tool once if it shows something else now", 'memory additivity', '16052 vs 16037 your tune through our route', 'First failure', 'silent error at +60 core (stage 1)', 'The card holds 3225 / 16037 now; as found 3225 / 16008 (the same within 1 %).', '>Current OC<', '>Reference<', '>Certified<', '2407 MHz boost', '28 Gbps']);
    // No Board column of "unknown" until boards.json exists; nothing invented, nothing from the old Keep / validate flow.
    expect(results).not.toContain('>Board<');
    expect(results).not.toContain('>unknown<');
    expect(results).not.toContain('Set in the tool');
    expect(results).not.toContain('left the card as it found it');
    for (const gone of ['Keep', 'Validate', 'validated', 'promoted', 'known-good', 'logon']) expect(results).not.toContain(gone);
    expect(results).toContain('Save as .html');
    expect(results).toContain('Revert');
    expect(results).not.toMatch(/undefined|NaN/);
    // Copy carries the collector's text when it wrote one, else the mirror's same lines.
    expect(textOf(RESULT, EXPORT)).toContain('Type into GPU Tweak / Afterburner: core +364, memory +4192');
    expect(textOf(RESULT, { ...EXPORT, text: 'from the collector' })).toBe('from the collector');
    // A stock card's value set is the certified pair in slider units under the same label.
    const stock = renderToStaticMarkup(<Results status={{ ...STATUS, result: { ...RESULT, vendor: null, baseline: deltas(0), deltas: deltas(45, 60) } }} export={null} gates={gates(true, connected, STATUS, null)} busy={null} deviceClass="high-end-pc" gpuName="NVIDIA GeForce RTX 5090" onRevert={() => undefined} onSave={null} />);
    inOrder(stock, ['Type into GPU Tweak / Afterburner', 'core +45 · memory +120', 'Certified on top (NVML MHz)', 'core +45 · mem +60 MHz', 'the P0 offsets are back where they were']);
    expect(stock).not.toContain('On top of your tune');
  });

  it('a result with nothing certified says so and offers no values', () => {
    const none = { ...STATUS, result: { ...RESULT, certified: { coreMhz: 0, memMhz: 0 }, deltas: RESULT.baseline, official: null, heldAtCertified: RESULT.baselineHeld } };
    const html = renderToStaticMarkup(<Results status={none} export={null} gates={gates(true, connected, none, null)} busy={null} deviceClass="high-end-pc" gpuName="NVIDIA GeForce RTX 5090" onRevert={() => undefined} onSave={null} />);
    expect(html).toContain('Nothing above the card as found could be certified');
    expect(html).not.toContain('Type these into');
    expect(html).toContain('11,701');
  });

  it('controls: the hunt with its estimate, one ladder alone, Stop; no Validate or Keep; a refusal renders as plain text', () => {
    const { controls } = render(STATUS, null);
    expect(controls).toContain('Find headroom (about 17 min)');
    expect(controls).toContain('Memory only');
    expect(controls).toContain('Core only');
    expect(controls).toContain('Stop');
    expect(controls).not.toContain('Validate');
    expect(controls).not.toMatch(/>Keep<|Keep \(validate\)/);
    const refusal = 'your card holds a tune we cannot see - enter what your vendor tool shows first (memory 16008 MHz against a 14001 MHz ceiling)';
    const refused = renderToStaticMarkup(<Controls gates={gates(true, connected, STATUS, null)} busy={null} refusal={refusal} estimateMinutes={16} onFind={() => undefined} onStop={() => undefined} />);
    expect(refused).toContain(refusal);
    expect(refused).toContain('text-amber-300');
    expect(refused).not.toContain('truncate');
  });

  it('the vendor form: two fields in the slider units, prefilled from the last run, and the cross-check against what the card holds', () => {
    const html = renderToStaticMarkup(<VendorForm lastRun={RESULT.vendor} held={{ smMhz: 3225, memMhz: 16008 }} ceilingMemMhz={14001} disabled={false} />);
    expect(html).toContain('What does your vendor tool show?');
    expect(html).toContain('value="319"');
    expect(html).toContain('value="4072"');
    expect(html).toContain('Matches the 16008 MHz the card holds (14001 + 2007; +2036 in our units).');
    expect(vendorCheck({ value: 3672, unit: 'effective' }, { smMhz: 3225, memMhz: 16008 }, 14001)).toMatchObject({ tone: 'warn' });
    expect(vendorCheck({ value: 4072, unit: 'effective' }, { smMhz: 2947, memMhz: 14001 }, 14001).text).toContain('Does not match: the card holds 14001 MHz, the driver ceiling, not 14001 + 2036');
    expect(vendorCheck({ value: 2036, unit: 'nvml' }, { smMhz: 3225, memMhz: 16008 }, 14001).tone).toBe('ok');
    expect(vendorCheck({ value: 4072, unit: 'effective' }, null, 14001).text).toContain('not checked yet');
    expect(vendorCheck(null, null, null).text).toContain('Nothing entered');
  });

  it("the warning is plan 27a's body verbatim, the one risk line, the sentence about what is written, and the disclaimer's section behind a collapsed link", () => {
    const html = renderToStaticMarkup(<TuneWarning isOpen onAccept={() => undefined} onClose={() => undefined} />);
    expect(html).toContain(esc(WARNING_BODY));
    expect(html).toContain(esc(WARNING_RISK));
    expect(WARNING_BODY).toContain('tests each one for about a minute');
    expect(WARNING_BODY).toContain('stops at the first small mistake');
    expect(WARNING_BODY).toContain('freeze for a second or two when the driver resets; that is the signal we stop on');
    expect(WARNING_BODY).toContain('Nothing changes voltage, power limits or fans, and the card is left exactly as it was found');
    expect(WARNING_BODY).toContain("you type the values it finds into your vendor's tool");
    // The route in one line (plan 27a: short; the body already says nothing changes voltage, power limits or fans, so the clause is not said twice).
    expect(html).toContain(esc(WRITES_ROUTE_LINE));
    expect(html).not.toContain(esc(WRITES_SENTENCE));
    expect((html.match(/voltage, power limits or fan/g) ?? []).length).toBe(1);
    expect(html).toContain('<details');
    expect(html).toContain('may void your hardware warranty');
    // DISCLAIMER.md section 3 describes the product as built: offsets tested and put back, values applied by the user, no voltage, power limit or fan change.
    expect(html).toContain('puts the card back as it found it');
    expect(html).toContain('never changes a voltage, a power limit or a fan curve');
    expect(html).not.toContain('applies only the changes you allow');
    // Plan 17d row 2: the gaming laptop's line about the vendor app's own OC mode, only there.
    expect(html).not.toContain('Armoury Crate');
    expect(renderToStaticMarkup(<TuneWarning isOpen laptop onAccept={() => undefined} onClose={() => undefined} />)).toContain(esc(WARNING_LAPTOP_LINE));
    expect(html).toContain('records this acknowledgement');
    // The old four-section modal and its Keep / logon-task copy are gone.
    for (const gone of ['What it does', 'What can happen', 'Before you start', 'Keep', 'logon task', 'until the next reboot']) expect(html).not.toContain(gone);
    expect(hardwareRiskSection().length).toBeGreaterThan(2);
  });

  it('the Headroom section is one line while the switch is off, and the power-cap sentence names the limit', () => {
    store.set('strata-tune.settings', JSON.stringify({ enableTune: false }));
    const off = renderToStaticMarkup(<Headroom />);
    expect(off).toContain(esc(HEADROOM_OFF));
    expect(off).not.toContain(HEADROOM_TAGLINE);
    store.delete('strata-tune.settings');
    const gpu = devboxTick().gpu[0];
    expect(powerCapSentence({ ...gpu, powerLimitMw: 600_000, powerMaxLimitMw: 600_000 })).toContain('already at its maximum (600 W)');
    expect(powerCapSentence({ ...gpu, powerLimitMw: 575_000, powerMaxLimitMw: 600_000 })).toBeNull();
    expect(powerCapSentence(undefined)).toBeNull();
  });

  it("live monitor: a run's closing sentence and the last event wrap under their label, never widening the panel (workflow 13b)", () => {
    const sentence = 'the driver is not adding our offset on top of your tune: the +30 MHz core rung held 3337 MHz against 3337 MHz your tune through our route (at least 3355 was expected)';
    const failed: TuneRun = { ...HUNTING, state: 'failed', error: sentence, lastEvent: sentence };
    const html = render(STATUS, failed).monitor;
    const i = html.indexOf(sentence);
    expect(i).toBeGreaterThan(0);
    const span = html.lastIndexOf('<span', i);
    expect(html.slice(span, i)).toContain('whitespace-normal break-words');
    expect(html.slice(span, i)).not.toContain('whitespace-nowrap');
    // The numeric facts keep their one line; the event line of a running hunt wraps too.
    const live = render(STATUS, { ...HUNTING, lastEvent: 'additivity not yet shown: the +15 MHz core rung holds 3337 MHz against 3330 MHz as found, within a bin; the +30 MHz rung decides' }).monitor;
    expect(live.slice(live.lastIndexOf('<span', live.indexOf('additivity not yet shown')), live.indexOf('additivity not yet shown'))).toContain('whitespace-normal');
    expect(live.slice(live.lastIndexOf('<span', live.indexOf('09:00')), live.indexOf('09:00'))).toContain('whitespace-nowrap');
    // The rung counter counts within the ladder under test, so it matches the tiles: the third core rung.
    expect(live).toContain('climb · core rung 3');
  });

  it('the Headroom section on a machine without a supported card is the header and the reason alone (plan 17d): no state strip, form, controls, climb or live monitor', () => {
    const laptop = fixtures.find((f) => f.class === 'laptop-no-dgpu')!;
    const html = renderToStaticMarkup(<HeadroomUnavailable reason={laptop.tune.status.nvapi.reason!} problem={null} />);
    expect(html).toContain(esc(HEADROOM_NEEDS_NVIDIA));
    expect(html).toContain('integrated Radeon GPU only');
    expect(html).not.toContain(esc(HEADROOM_TAGLINE));
    for (const gone of ['Live monitor', 'Perf limit', 'No test running', 'What does your vendor', 'Find headroom', 'Score climb', 'Baseline']) expect(html).not.toContain(gone);
  });

  it('the vendor form warns before Find when the tick already shows a tune above the driver ceiling and nothing is entered, and carries the "never test above" caps', () => {
    expect(vendorCheck(null, { smMhz: 3225, memMhz: 16008 }, 14001)).toEqual({ tone: 'warn', text: "Your card holds 16008 MHz memory, 2007 above the driver's 14001 ceiling: another tool is tuning it (about +4014 on its slider). Enter what that tool's sliders show before the hunt, or it is refused before anything is written." });
    expect(vendorCheck(null, { smMhz: 2947, memMhz: 14001 }, 14001).tone).toBe('muted');
    // useSettings keeps one shared copy: the patch goes through it, as the form's own inputs would.
    updateSettings({ coreCapMhz: 3300 });
    const html = renderToStaticMarkup(<VendorForm lastRun={null} held={null} ceilingMemMhz={null} disabled={false} laptop />);
    updateSettings({ coreCapMhz: null });
    expect(html).toContain('Never test above');
    expect(html).toContain('value="3300"');
    expect(html).toContain('placeholder="no cap"');
    expect(html).toContain('Armoury Crate');
    expect(html).not.toContain('a tune we cannot see');
  });

  it("the comparison sheet's DIMM voltage is the board's DIMM rail from the live tick (the dev box reads 1.408 V), null when no rail matches", () => {
    const index = new SensorIndex(devboxMeta());
    expect(dimmVoltageOf(index, devboxTick(), devbox().cpu.name)).toBeCloseTo(1.408, 3);
    expect(dimmVoltageOf(new SensorIndex(devboxMeta().filter((m) => !/^(SuperIO|EmbeddedController)$/i.test(m.hardwareType))), devboxTick(), devbox().cpu.name)).toBeNull();
    expect(dimmVoltageOf(null, null, undefined)).toBeNull();
  });

  it('flight recorder: the banner names the values, the chart draws the samples, throttle marks and ladder events', () => {
    const tick = devboxTick();
    const lines: FlightLine[] = [];
    for (let i = 0; i < 30; i++) {
      const gpu = { ...tick.gpu[0], clocks: { smMhz: 3200 + i, memMhz: 15800 }, clocksEventReasons: { raw: i > 25 ? 4 : 0, names: [] } };
      lines.push({ kind: 'sample', at: new Date(Date.UTC(2026, 8, 16, 9, 41, i)).toISOString(), qpc: i, gpu, cpu: null, sensors: {} });
    }
    lines.push({ kind: 'event', at: new Date(Date.UTC(2026, 8, 16, 9, 41, 3)).toISOString(), text: 'candidate +150 applied', candidate: deltas(150), stage: null, pattern: 'variable' });
    const reverted = { candidate: deltas(150), baseline: deltas(0), at: '2026-09-16 09:41', reason: 'hard hang (stage 4)', stage: 4 };
    const html = renderToStaticMarkup(<FlightRecorder reverted={reverted} flight={lines} />);
    expect(html).toContain('hard-hung at core +150 / memory +0 MHz');
    expect(html).toContain('<path');
    expect((html.match(/<rect/g) ?? []).length).toBe(5);
    expect(html).toContain('candidate +150 applied');
  });
});

describe('device classes on the page (plan 17d): every class reads right, nothing empty, every absence explained', () => {
  it.each(fixtures.map((f) => [f.class, f] as const))('%s', (cls, f) => {
    const { status, export: exp } = f.tune;
    const g = gates(true, connected, status, null);
    const controls = renderToStaticMarkup(<Controls gates={g} busy={null} refusal={null} estimateMinutes={status.estimateMinutes} onFind={() => undefined} onStop={() => undefined} />);
    if (!status.nvapi.available) {
      // The reason is the disabled line under the buttons, in the collector's words.
      expect(g.find).toBe(status.nvapi.reason);
      expect(controls).toContain(esc(status.nvapi.reason!));
      expect(status.nvapi.reason).toMatch(/no supported GPU|NVIDIA cards only/);
      return;
    }
    const results = renderToStaticMarkup(<Results status={status} export={exp} gates={g} busy={null} deviceClass={cls} gpuName={f.snapshot.gpus[0]?.name} onRevert={() => undefined} onSave={() => undefined} />);
    expect(results).toContain(DEVICE_CLASS_LABEL[cls]);
    expect(results).toMatch(/[\d,]+ points/);
    expect(results).toContain('over your current tune');
    expect(results).toMatch(/The card holds \d+ \/ \d+ now; as found \d+ \/ \d+/);
    expect(results).not.toMatch(/undefined|NaN|\bnull\b/);
    const climb = renderToStaticMarkup(<ScoreClimb run={null} rungs={status.result!.rungs} asFound={status.result!.asFound} official={status.result!.official} baseline={status.baseline} />);
    expect(climb).toContain('as found');
    expect(climb).toContain('>memory<');
    expect(climb).toContain('>core<');
    // A laptop card has its own reference row now (plan 17d row 2); the table shows the reference column, no placeholder text.
    if (cls === 'gaming-laptop') {
      expect(results).toContain('>Reference<');
      expect(results).not.toContain('no reference row');
      expect(results).toContain('2175 MHz boost');
    }
  });
});
