import { describe, expect, it } from 'vitest';
import type { TuneResult } from '../src/collector-types';
import {
  atStart,
  confidence,
  CORE_RESOLUTION_KHZ,
  CORE_STEP_KHZ,
  exportText,
  judge,
  median,
  MEM_RESOLUTION_KHZ,
  MEM_STEP_KHZ,
  midpoint,
  nextCoarse,
  patternVerdict,
  regressed,
  regressionFloor,
  spread,
  SWEEP_PATTERNS,
  THROTTLE_BITS,
  type StartFacts
} from '../src/analysis/tune';

describe('ladder steps (plan §16, mirrored from TuneLadder.cs)', () => {
  it('climbs in 30 MHz core steps from the baseline and stops at the driver max', () => {
    expect(nextCoarse(0, CORE_STEP_KHZ, 1_000_000)).toBe(30_000);
    expect(nextCoarse(229_000, CORE_STEP_KHZ, 1_000_000)).toBe(259_000);
    expect(nextCoarse(990_000, CORE_STEP_KHZ, 1_000_000)).toBeNull();
    expect(nextCoarse(970_000, CORE_STEP_KHZ, 1_000_000)).toBe(1_000_000);
  });

  it('bisects a 30 MHz gap once to 15 MHz and a 100 MHz memory gap twice to 25 MHz', () => {
    expect(midpoint(60_000, 90_000, CORE_RESOLUTION_KHZ)).toBe(75_000);
    expect(midpoint(60_000, 75_000, CORE_RESOLUTION_KHZ)).toBeNull();
    expect(midpoint(200_000, 300_000, MEM_RESOLUTION_KHZ)).toBe(250_000);
    expect(midpoint(250_000, 300_000, MEM_RESOLUTION_KHZ)).toBe(275_000);
    expect(midpoint(275_000, 300_000, MEM_RESOLUTION_KHZ)).toBeNull();
    expect(nextCoarse(0, MEM_STEP_KHZ, 1_500_000)).toBe(100_000);
  });

  it('lands on whole MHz even from an odd baseline', () => {
    expect(midpoint(229_000, 259_000, CORE_RESOLUTION_KHZ)).toBe(244_000);
  });
});

describe('failure ladder verdicts', () => {
  it('reads the worker exit codes per pattern: 2 is stage 1, 10 is stage 3, 0 passes on to the judgement', () => {
    expect(patternVerdict(2, false)).toEqual({ verdict: 'unstable', stage: 1 });
    expect(patternVerdict(10, false)).toEqual({ verdict: 'device-lost', stage: 3 });
    expect(patternVerdict(0, false)).toEqual({ verdict: 'stable', stage: null });
    expect(judge(0, true, 1600, 1610, null)).toEqual({ verdict: 'stable', stage: null });
  });

  it('a stale heartbeat is a TDR whatever the exit code says', () => {
    expect(patternVerdict(0, true)).toEqual({ verdict: 'device-lost', stage: 3 });
  });

  it('stage 2 is bandwidth more than 3 % under the running best, or more than three times the baseline noise', () => {
    expect(regressed(1552, 1600)).toBe(false);
    expect(regressed(1551, 1600)).toBe(true);
    expect(regressed(1000, null)).toBe(false);
    expect(judge(0, true, 1500, 1600, null)).toEqual({ verdict: 'unstable', stage: 2 });
    // The dev box under the collector: 1330 / 1409 / 1451 at one step is a 9 % spread, so the floor is 27 %.
    expect(regressionFloor(0.09)).toBeCloseTo(0.27);
    expect(regressionFloor(0.005)).toBe(0.03);
    expect(judge(0, false, 1330, 1451, 0.09)).toEqual({ verdict: 'stable', stage: null });
    expect(judge(0, false, 1000, 1451, 0.09)).toEqual({ verdict: 'unstable', stage: 2 });
  });

  it('a throttled heavy pattern is invalid before the bandwidth is looked at, and only when the gate is on', () => {
    expect(judge(0.5, true, null, null, null)).toEqual({ verdict: 'invalid', stage: null });
    expect(judge(0.05, true, null, null, null)).toEqual({ verdict: 'stable', stage: null });
    // A power-capped step is slower because of the cap, not the memory: invalid, never stage 2.
    expect(judge(0.77, true, 1400, 1600, null)).toEqual({ verdict: 'invalid', stage: null });
    // The validate run and the memory sweep run with the gate off: 77 % SwPowerCap at the user's fan curve passes.
    expect(judge(0.77, false, null, null, null)).toEqual({ verdict: 'stable', stage: null });
  });

  it('exit 1 and exit 3 are not verdicts', () => {
    expect(patternVerdict(1, false)).toBeNull();
    expect(patternVerdict(3, false)).toBeNull();
  });

  it('a sweep step is three passes, a median and a spread', () => {
    expect(SWEEP_PATTERNS.length).toBe(3);
    expect(median([1451, 1330, 1409])).toBe(1409);
    expect(median([1400, 1500])).toBe(1450);
    expect(spread([1451, 1330, 1409])).toBeCloseTo(121 / 1409);
    expect(spread([1415])).toBe(0);
  });

  it('the throttle mask is the five limit bits, not the idle indicators', () => {
    expect(THROTTLE_BITS & 0x400).toBe(0);
    expect(THROTTLE_BITS & 0x1).toBe(0);
    expect(THROTTLE_BITS & 0x4).toBe(0x4);
    expect(THROTTLE_BITS & 0x40).toBe(0x40);
  });
});

describe('confidence', () => {
  it('is high only for a clean converged result above the baseline', () => {
    expect(confidence(true, false, 0, false, true)).toBe('high');
    expect(confidence(true, false, 1, false, true)).toBe('medium');
    expect(confidence(true, false, 0, true, true)).toBe('medium');
    expect(confidence(true, true, 0, false, true)).toBe('medium');
    expect(confidence(false, false, 0, false, true)).toBe('low');
    expect(confidence(true, false, 0, false, false)).toBe('low');
  });
});

describe('rollback state machine at start (mirrored from TuneStateMachine.AtStart)', () => {
  const c = { coreKhz: 30_000, memKhz: 0, coreMhz: 30, memMhz: 0 };
  const sameBoot: StartFacts = { sameBoot: true, unexpectedShutdown: null, onCard: true };
  const cleanBoot: StartFacts = { sameBoot: false, unexpectedShutdown: false, onCard: false };
  const dirtyBoot: StartFacts = { sameBoot: false, unexpectedShutdown: true, onCard: false };
  const unknownBoot: StartFacts = { sameBoot: false, unexpectedShutdown: null, onCard: false };

  it('reverts a PENDING candidate whether or not the shutdown was clean', () => {
    expect(atStart({ state: 'PENDING', candidate: c, cleanShutdown: false }, sameBoot)).toBe('revert');
    expect(atStart({ state: 'PENDING', candidate: c, cleanShutdown: true }, cleanBoot)).toBe('revert');
  });

  it('reverts a kept result the collector or the machine died with', () => {
    expect(atStart({ state: 'VALIDATING', candidate: c, cleanShutdown: false }, sameBoot)).toBe('revert');
    expect(atStart({ state: 'VALIDATING', candidate: c, cleanShutdown: false }, cleanBoot)).toBe('revert');
  });

  it('a clean collector exit in the same boot promotes nothing: the kept result stays on the card until a boot decides', () => {
    expect(atStart({ state: 'VALIDATING', candidate: c, cleanShutdown: true }, sameBoot)).toBe('none');
    // The driver dropped it (a reset or a reload while the app was closed): nothing to certify.
    expect(atStart({ state: 'VALIDATING', candidate: c, cleanShutdown: true }, { ...sameBoot, onCard: false })).toBe('forget');
  });

  it('a new boot promotes only when the System log shows no dirty shutdown since the apply; Kernel-Power 41 makes it a crash', () => {
    expect(atStart({ state: 'VALIDATING', candidate: c, cleanShutdown: true }, cleanBoot)).toBe('promote');
    // Keep, close the app cleanly, play for hours, hard hang, reboot: the value is blamed, not certified.
    expect(atStart({ state: 'VALIDATING', candidate: c, cleanShutdown: true }, dirtyBoot)).toBe('revert');
    expect(atStart({ state: 'VALIDATING', candidate: c, cleanShutdown: true }, unknownBoot)).toBe('forget');
  });

  it('does nothing at KNOWN_GOOD or REVERTED, or without a candidate', () => {
    expect(atStart({ state: 'KNOWN_GOOD', candidate: null, cleanShutdown: true }, cleanBoot)).toBe('none');
    expect(atStart({ state: 'REVERTED', candidate: null, cleanShutdown: false }, sameBoot)).toBe('none');
    expect(atStart({ state: 'PENDING', candidate: null, cleanShutdown: false }, sameBoot)).toBe('none');
  });
});

describe('export text (mirrored from TuneSupervisor.Export)', () => {
  const d = (coreMhz: number, memMhz = 0) => ({ coreKhz: coreMhz * 1000, memKhz: memMhz * 1000, coreMhz, memMhz });
  const base: TuneResult = { kind: 'core', deltas: d(90), baseline: d(0), bandwidthGBs: null, referenceHash: 'abc', confidence: 'high', validated: false, foundAt: '2026-09-17T01:56:10Z', promoted: false, referenceSmMhz: 3210, referenceMemMhz: 1979, throttledFraction: null };

  it('a result above the baseline is absolute offsets; the baseline itself is not a finding', () => {
    const text = exportText(base, '2026-09-16');
    expect(text).toContain('Strata Tune core result, 2026-09-16 (high confidence, not yet validated)');
    expect(text).toContain('GPU core clock offset:    +90 MHz');
    expect(text).toContain('These are absolute offsets to type into MSI Afterburner or ASUS GPU Tweak III.');
    expect(text).toContain('core 3210 / memory 1979 MHz under load');
    expect(text).toContain('do not survive a reboot');
    expect(exportText({ ...base, deltas: d(0) }, '2026-09-16')).toContain('these are the baseline values, not a finding');
  });

  it('validation and promotion read on the first line, with the power-limited share when there was one', () => {
    expect(exportText({ ...base, validated: true, throttledFraction: 0.77 }, '2026-09-16')).toContain('validated 5 min heavy + 2 min transient (power- or thermal-limited 77 % of the time at your fan curve)');
    expect(exportText({ ...base, validated: true, promoted: true }, '2026-09-16')).toContain('kept through a clean shutdown and a clean boot');
    expect(exportText({ ...base, referenceSmMhz: null }, '2026-09-16')).toContain('were not recorded');
  });
});
