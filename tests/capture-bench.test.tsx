import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { benchExitMessage, benchSize, lockHolder, parseSummary } from '../electron/bench-run';
import { benchSegment, benchSegmentLabel } from '../src/components/capture/LiveFrames';
import { toReport } from '../src/components/capture/toReport';
import { analyseSession } from '../src/analysis/stutter';
import { ReportView } from '../src/report/ReportView';
import type { Report } from '../src/report/report-types';
import { session, steady } from './fixtures/frames';
import { benchSession } from './fixtures/bench-session';
import benchReport from './fixtures/bench.report.json';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-tune-bench-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const display = (w: number, h: number, scale = 1, taskbar = 48) => ({ size: { width: w, height: h }, workAreaSize: { width: w, height: h - taskbar }, scaleFactor: scale });

describe('the built-in bench run (plan section 11a)', () => {
  it('sizes the window to the primary display, capped at 1080p, and shrinks it to fit the work area', () => {
    expect(benchSize(display(2560, 1440))).toEqual({ width: 1920, height: 1080 });
    expect(benchSize(display(3840, 2160, 1.5))).toEqual({ width: 1920, height: 1080 });
    // A 1080p screen: 1920 wide would hang off it past the 64 px offset and the frame, so the client shrinks in proportion.
    const fit = benchSize(display(1920, 1080));
    expect(fit.width).toBeLessThan(1920);
    expect(fit.width + 64 + 16).toBeLessThanOrEqual(1920);
    expect(fit.height + 64 + 40).toBeLessThanOrEqual(1032);
    expect(Math.abs(fit.width / fit.height - 16 / 9)).toBeLessThan(0.01);
    expect(fit.width % 2).toBe(0);
  });

  it('says what each exit code means in plain words', () => {
    expect(benchExitMessage(0, '')).toBeNull();
    expect(benchExitMessage(2, '')).toBeNull();
    expect(benchExitMessage(3, '')).toMatch(/no DX12 hardware GPU/);
    expect(benchExitMessage(10, 'device removed: DXGI_ERROR_DEVICE_HUNG')).toBe('The GPU was lost during the bench (the driver reset it): device removed: DXGI_ERROR_DEVICE_HUNG');
    expect(benchExitMessage(11, 'Strata Video is using the GPU (pid 1234); the bench needs the card to itself.')).toMatch(/^Strata Video is using the GPU/);
    expect(benchExitMessage(1, 'unknown argument --x')).toBe('The bench exited with code 1: unknown argument --x');
  });

  it('reads the --json summary line and ignores anything else on stdout', () => {
    const line = '{"script":"full","device":"NVIDIA GeForce RTX 5090","luid":78720,"pid":6784,"width":1920,"height":1080,"vsync":false,"fpsCap":120,"vramTargetPercent":40,"completed":true,"frames":10800,"seconds":90.02,"segments":[{"name":"warm-up","start":0,"end":10,"frames":1200,"avgFps":119.9,"maxFrameMs":8.7,"avgGpuMs":0.01}],"pipelineStates":85,"texturesUploaded":60,"uploadedMiB":3840,"heavyIterations":27430}';
    const s = parseSummary(`{not json\r\n${line}\r\n`);
    expect(s?.completed).toBe(true);
    expect(s?.segments[0].name).toBe('warm-up');
    expect(s?.pid).toBe(6784);
    expect(parseSummary('')).toBeNull();
  });

  it('refuses over a live lock holder and ignores a dead or own one, like GpuLock.cs', () => {
    const file = path.join(tmp, 'gpu.lock');
    fs.writeFileSync(file, JSON.stringify({ holder: 'strata-video', pid: process.pid, since: '2026-09-16T00:00:00Z' }));
    expect(lockHolder(file, 1)).toBe(`Strata Video is using the GPU (pid ${process.pid}); the bench needs the card to itself.`);
    expect(lockHolder(file, process.pid)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ holder: 'strata-tune-bench', pid: 999_999_999, since: '2026-09-16T00:00:00Z' }));
    expect(lockHolder(file, 1)).toBeNull();
    expect(lockHolder(path.join(tmp, 'missing.lock'), 1)).toBeNull();
  });

  it('names the script segment by elapsed seconds for the live line, in the words a first-time user reads', () => {
    expect(benchSegment(0)).toBe('Warm-up');
    expect(benchSegment(9.9)).toBe('Warm-up');
    expect(benchSegment(10)).toBe('Shader compile');
    expect(benchSegment(44)).toBe('Texture streaming');
    expect(benchSegment(59)).toBe('CPU stall');
    expect(benchSegment(89)).toBe('GPU load');
    expect(benchSegment(95)).toBe('finishing');
    // The report's bench table prints the same labels for the script's ids; an id the table does not know stays as it is.
    expect(benchSegmentLabel('cpu-stall')).toBe('CPU stall');
    expect(benchSegmentLabel('custom')).toBe('custom');
  });

  it('a bench the desktop composed says so under the verdict; a bench in front and a game do not', () => {
    const base = structuredClone(benchReport as Report);
    const line = 'The bench window was composed by the desktop (not in front)';
    const render = (r: Report) => renderToStaticMarkup(<ReportView report={r.report} session={r.session} />);
    expect(render(base)).not.toContain(line);
    const composed = structuredClone(base);
    composed.session.presentMode = 'Composed: Flip';
    expect(render(composed)).toContain(line);
    // The 8:01 PM run: 15.5 ms typical against the 8.3 ms cap period, whatever the mode said.
    const slow = structuredClone(base);
    slow.report.measurements.typicalMs = 15.5;
    expect(render(slow)).toContain(line);
    const game = structuredClone(composed);
    delete game.session.bench;
    expect(render(game)).not.toContain(line);
  });

  it('marks a bench session as a bench report by its exe', () => {
    const s = { ...session(steady(20, 8.3)), game: { pid: 7, exe: 'strata-tune-bench.exe', path: null } };
    expect(toReport(s, analyseSession(s), '0.1.0').session.bench).toBe(true);
    const g = session(steady(20, 8.3));
    expect(toReport(g, analyseSession(g), '0.1.0').session.bench).toBeUndefined();
  });

  it("carries the classifier's bench check into the report untouched, and only for a bench", () => {
    const s = benchSession();
    const a = analyseSession(s);
    const r = toReport(s, a, '0.1.0');
    expect(r.report.benchCheck).toBe(a.benchCheck);
    expect(r.report.benchCheck?.rows.map((row) => row.segment)).toEqual(['warm-up', 'shader-compile', 'texture-stream', 'cpu-stall', 'gpu-load']);
    const g = session(steady(20, 8.3));
    expect(toReport(g, analyseSession(g), '0.1.0').report.benchCheck).toBeUndefined();
  });
});
