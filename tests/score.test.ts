import { describe, expect, it } from 'vitest';
import type { AuditFinding } from '../src/analysis/audit';
import { configurationScore, efficiencyScore, smoothnessScore, STABILITY_CAP, systemScore, thermalsScore, topFix, type ScoreInputs, type SmoothnessInput } from '../src/analysis/score';
import { loadRun } from './fixtures';

const finding = (id: string, state: AuditFinding['state'], severity: AuditFinding['severity'], costEstimate: number): AuditFinding =>
  ({ id, title: id, state, severity, costEstimate, costText: '', detail: '', fix: '', fixWhere: 'bios' });

const clean = [finding('expo', 'ok', 0, 0), finding('rebar', 'ok', 0, 0), finding('gpu-driver-age', 'info', 1, 0.02), finding('cpu-smt', 'unknown', 0, 0)];
const expoOff = finding('expo', 'bad', 3, 0.15);
const powerSaver = finding('power-plan', 'bad', 3, 0.25);
const rebarPartly = finding('rebar', 'warn', 1, 0.05);

const smooth = (lostPct: number, engineLostMs = 0, pacingStdevMs = 0.4): SmoothnessInput => ({
  measurements: { lostPct, typicalMs: 7, pacingStdevMs },
  causes: engineLostMs > 0 ? [{ case: 1, lostMs: 500 }, { case: 8, lostMs: engineLostMs }] : [{ case: 1, lostMs: 500 }],
  durationS: 100
});

const flat4060 = loadRun('heavy', 60, () => ({ smMhz: 2500, powerMw: 112_000, temperatureC: 64 }));
/** 15 % sag from t = 10 s with the thermal bit on half the samples. */
const hot5090 = loadRun('heavy', 60, (t) => ({ smMhz: t < 10 ? 2800 : 2380, powerMw: 575_000, temperatureC: t < 10 ? 70 : 88, clocksEventReasons: t >= 30 ? 0x40 : 0 }));

const base: ScoreInputs = { findings: clean, run: flat4060, spec: { boostMhz: 2460, tdpW: 115 }, smoothness: smooth(0.3), stability: { tdr: false, computeError: false }, validity: { backgroundLoad: false, throttled: false, thermalDrift: false } };

describe('Configuration subscore', () => {
  it('is 100 with nothing to fix; info and unknown findings cost nothing', () => {
    expect(configurationScore(clean)).toBe(100);
    expect(topFix(clean)).toBeNull();
  });

  it('subtracts severity × cost per warn or bad finding and floors at 0', () => {
    expect(configurationScore([...clean, expoOff])).toBe(55);
    expect(configurationScore([...clean, rebarPartly])).toBe(95);
    expect(configurationScore([...clean, expoOff, powerSaver])).toBe(0);
    expect(topFix([...clean, expoOff, rebarPartly])?.id).toBe('expo');
  });
});

describe('Thermals subscore', () => {
  it('a flat run scores 100', () => {
    expect(thermalsScore(flat4060)).toBe(100);
  });

  it('sag under the peak and throttle bits both cost points', () => {
    // Steady window t ≥ 3 s: 14 samples at 2800 then 100 at 2380 → 13.2 % sag → 53 points; the bit on 60 of 114 → 32 more.
    expect(thermalsScore(hot5090)).toBe(16);
  });

  it('an unfinished run is not measured', () => {
    expect(thermalsScore({ ...flat4060, state: 'failed' })).toBeNull();
  });
});

describe('Smoothness subscore', () => {
  it('each 1 % of playtime lost costs 10 points', () => {
    expect(smoothnessScore(smooth(0))).toBe(100);
    expect(smoothnessScore(smooth(3))).toBe(70);
    expect(smoothnessScore(smooth(12))).toBe(0);
  });

  it('cases 7 and 8 are excluded: the engine’s stutters are not the machine’s', () => {
    // 3 % lost over 100 s, 2 000 ms of it in engine stalls → 1 % counts.
    expect(smoothnessScore(smooth(3, 2000))).toBe(90);
    const tick: SmoothnessInput = { ...smooth(3), causes: [{ case: 1, lostMs: 500 }, { case: 7, lostMs: 2000 }] };
    expect(smoothnessScore(tick)).toBe(90);
    const fixable: SmoothnessInput = { ...smooth(3), causes: [{ case: 1, lostMs: 500 }, { case: 4, lostMs: 2000 }] };
    expect(smoothnessScore(fixable)).toBe(70);
  });

  it('pacing over 10 % of the typical frame time costs up to 20 points', () => {
    expect(smoothnessScore(smooth(0, 0, 1.4))).toBe(95);
    expect(smoothnessScore(smooth(0, 0, 7))).toBe(80);
  });
});

describe('Efficiency subscore', () => {
  it('rated boost at TDP is 100; the spec is the placeholder expectation', () => {
    expect(efficiencyScore(loadRun('heavy', 60, () => ({ smMhz: 2407, powerMw: 575_000 })), { boostMhz: 2407, tdpW: 575 })).toBe(100);
  });

  it('a lower clock per watt scores proportionally, and an undervolt is capped', () => {
    expect(efficiencyScore(loadRun('heavy', 60, () => ({ smMhz: 2046, powerMw: 575_000 })), { boostMhz: 2407, tdpW: 575 })).toBe(85);
    expect(efficiencyScore(loadRun('heavy', 60, () => ({ smMhz: 2407, powerMw: 450_000 })), { boostMhz: 2407, tdpW: 575 })).toBe(100);
  });
});

describe('systemScore (plan §14)', () => {
  it('a well-configured 4060 beats a misconfigured 5090', () => {
    const rtx4060 = systemScore(base);
    const rtx5090 = systemScore({ ...base, findings: [...clean, expoOff, powerSaver], run: hot5090, spec: { boostMhz: 2407, tdpW: 575 }, smoothness: smooth(4) });
    expect(rtx4060.total).toBeGreaterThanOrEqual(97);
    expect(rtx5090.total).toBeLessThan(50);
    expect(rtx5090.subscores.configuration).toBe(0);
    expect(rtx5090.topFix?.id).toBe('power-plan');
    expect(rtx4060.total!).toBeGreaterThan(rtx5090.total!);
  });

  it('a TDR or compute error caps the total at 60', () => {
    const s = systemScore({ ...base, stability: { tdr: true, computeError: false } });
    expect(s.capped).toBe(true);
    expect(s.total).toBe(STABILITY_CAP);
    expect(s.total).toBe(60);
  });

  it('background load, throttling or thermal drift make the run invalid and non-comparable', () => {
    const s = systemScore({ ...base, validity: { backgroundLoad: true, throttled: false, thermalDrift: true } });
    expect(s.valid).toBe(false);
    expect(s.total).toBeNull();
    expect(s.invalidReasons).toHaveLength(2);
    expect(s.subscores.configuration).toBe(100);
  });

  it('a missing subscore drops out of the mean and marks the score partial', () => {
    const s = systemScore({ ...base, smoothness: null });
    expect(s.complete).toBe(false);
    expect(s.subscores.smoothness).toBeNull();
    expect(s.total).toBe(100);
    expect(systemScore({ ...base, findings: null, run: null, smoothness: null }).total).toBeNull();
  });
});
