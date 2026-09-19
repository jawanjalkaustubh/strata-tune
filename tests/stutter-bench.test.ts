import { describe, expect, it } from 'vitest';
import { WARMUP_FRAMES } from '../src/analysis/frames';
import { analyseSession, periodicRuns } from '../src/analysis/stutter';
import type { StutterEvent, StutterReport } from '../src/analysis/session-types';
import { analyse } from '../src/components/capture/toReport';
import { benchMeta, benchSession } from './fixtures/bench-session';

/**
 * The real bench run (tests/fixtures/bench-session) against plan §11a's designed
 * signatures. Before this pass the same session read "Engine stall · 1.6 % of playtime
 * went to 36 stutters; the main cause was an engine stall" (session.json keeps that
 * headline): the shader-compile segment's decaying run of 50–70 ms CPU-side frames was
 * called engine stalls, and the cpu-stall segment's 2 s beat was never reported as one.
 * A second pass on the same session then had the texture-stream beat absorb the first
 * spin, so the 2 s beat read as seven at low confidence.
 */
const session = benchSession();
const report: StutterReport = analyseSession(session);
const origin = session.frames[0].timeInQpc;
const at = (e: StutterEvent) => (e.qpc - origin) / session.qpcFrequency;
const within = (from: number, to: number) => report.events.filter((e) => at(e) >= from && at(e) < to);
const ids = (events: StutterEvent[]) => [...new Set(events.map((e) => e.cause?.id ?? null))];
const row = (name: string) => report.benchCheck!.rows.find((r) => r.segment === name)!;

describe('the real bench session (plan §11a)', () => {
  it('is the session the user saw, and was read as an engine stall before', () => {
    expect(session.game.exe).toBe('strata-tune-bench.exe');
    expect(benchMeta().verdict).toMatch(/^Engine stall · 1\.6 % of playtime went to 36 stutters/);
    expect(report.stutterCount).toBe(36);
    expect(report.percentTimeLost).toBeCloseTo(1.6, 1);
  });

  it('skips the level load: no stutter is judged inside the first 300 frames', () => {
    expect(report.events.every((e) => e.index >= WARMUP_FRAMES)).toBe(true);
    expect(report.events.length).toBeGreaterThan(0);
  });

  it('shader-compile segment: every hitch is case 1, on a rate that fell by half or more and hitches that shrank', () => {
    const events = within(10, 30);
    expect(events.length).toBe(15);
    expect(ids(events)).toEqual(['shader-compile']);
    expect(events[0].cause).toMatchObject({ case: 1, fixable: true, confidence: 'high' });
    const fewer = events[0].cause!.evidence[1].match(/^(\d+) % fewer of these in the last third/);
    expect(Number(fewer![1])).toBeGreaterThanOrEqual(50);
    expect(events[0].cause!.evidence[2]).toMatch(/^and they shrank, from \d+\.\d ms of lost time each to \d+\.\d ms$/);
    expect(events[0].cause!.evidence[0]).toMatch(/CPU busy 6\d\.\d ms on a 6\d\.\d ms frame with the GPU idle/);
  });

  it('shader-compile segment: the bench compiles one batch a second, a beat the classifier sees and case 1 still takes, because the hitches lose half their cost along it', () => {
    const runs = periodicRuns(report.events, session.qpcFrequency);
    const compile = runs.find((r) => r.periodS < 1.5)!;
    expect(compile).toMatchObject({ count: 13 });
    expect(compile.cv).toBeLessThan(0.02);
    expect(compile.costFall).toBeGreaterThanOrEqual(0.5);
    expect(ids(report.events.slice(compile.from, compile.to))).toEqual(['shader-compile']);
  });

  it('cpu-stall segment: all eight 30 ms spins are one 2 s beat, case 7 at high confidence, the first spin included', () => {
    const events = within(45, 60);
    expect(events.length).toBe(8);
    expect(ids(events)).toEqual(['periodic']);
    expect(events.every((e) => e.cause!.fixable === false && e.cause!.case === 7 && e.cause!.confidence === 'high')).toBe(true);
    expect(events.every((e) => /^8 stutters every (1\.9|2\.0)\d s, varying by only \d %$/.test(e.cause!.evidence[0]))).toBe(true);
  });

  it('texture-stream segment: the bench streams on a 3 s beat, and the classifier says so without the spin that sits 3 s after the last burst', () => {
    const events = within(30, 45);
    expect(events.length).toBe(5);
    expect(ids(events)).toEqual(['periodic']);
    expect(events.every((e) => /^5 stutters every (2\.9|3\.0)\d s/.test(e.cause!.evidence[0]))).toBe(true);
    expect(events[0].cause!.confidence).toBe('low');
  });

  it('gpu-load segment: the card ran into its power cap, and what stuttered stays under the worth-fixing line', () => {
    const events = within(60, 90);
    expect(events.length).toBe(5);
    expect(ids(events).sort()).toEqual(['engine', 'power-limit', 'storage']);
    expect(events.find((e) => e.cause?.id === 'power-limit')!.cause!.evidence).toContain('the driver flagged the power cap');
    expect(row('gpu-load').lostPct).toBeLessThan(0.5);
  });

  it('a stall in the last third, the settled rate the decay was measured against, is the engine’s and not a compile', () => {
    const late = within(60, 90).filter((e) => e.cause?.id === 'engine');
    expect(late.length).toBe(3);
    expect(late[0].cause).toMatchObject({ case: 8, confidence: 'low' });
  });

  it('the bench check scores 3 of 4, and says which one the classifier missed', () => {
    const check = report.benchCheck!;
    expect(check.script).toBe('full');
    expect(check.assumedTimings).toBe(false);
    expect(check.score).toBe('3 of 4 designed segments classified as designed');
    expect(check.rows.map((r) => [r.segment, r.scored, r.match])).toEqual([
      ['warm-up', false, false],
      ['shader-compile', true, true],
      ['texture-stream', true, false],
      ['cpu-stall', true, true],
      ['gpu-load', true, true]
    ]);
    expect(row('shader-compile')).toMatchObject({ designed: 1, found: 1, stutters: 15 });
    expect(row('cpu-stall')).toMatchObject({ designed: 7, sameVerdict: [8], found: 7, stutters: 8 });
    expect(row('texture-stream')).toMatchObject({ designed: null, weak: [4, 5], found: 7, stutters: 5 });
    expect(row('gpu-load')).toMatchObject({ designed: null, weak: [2, 3], found: 8, stutters: 5, reached: true });
    expect(row('warm-up')).toMatchObject({ designed: null, found: 1, stutters: 3 });
  });

  it('without the bench summary (today’s load path) the full script’s timings stand in, and the check says so', () => {
    const check = analyseSession(benchSession(false)).benchCheck!;
    expect(check.assumedTimings).toBe(true);
    expect(check.score).toBe(report.benchCheck!.score);
    expect(check.rows.map((r) => [r.segment, r.startS, r.endS])).toEqual(report.benchCheck!.rows.map((r) => [r.segment, r.startS, r.endS]));
  });

  it('a game capture carries no bench check', () => {
    expect(analyseSession({ ...benchSession(false), game: { pid: 1, exe: 'game.exe', path: null } }).benchCheck).toBeUndefined();
  });

  it('the verdict the user now sees: shader compilation on top, the beat second, playing out', () => {
    expect(report.verdict).toBe('mixed');
    expect(report.causes.map((c) => c.id).slice(0, 2)).toEqual(['shader-compile', 'periodic']);
    expect(report.causes[0]).toMatchObject({ confidence: 'high', fixable: true });
    expect(report.causes[1]).toMatchObject({ confidence: 'high', fixable: false });
    expect(report.causes[1].text).toMatch(/every (1\.9|2\.0)\d s/);
    expect(report.causes[0].text).toMatch(/^Temporary: the game is compiling shaders the first time it meets new effects/);
    expect(report.causes[0].action).toMatch(/^Let it play out/);
    const { verdict } = analyse(session, 'test');
    expect(verdict).toMatch(/^Shader compilation · 1\.6 % of playtime went to 36 stutters; the main cause was shader compilation\./);
  });
});
