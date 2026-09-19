import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parsePresentMonCsv } from '../src/analysis/frames';

// The store roots itself under %LOCALAPPDATA%; pointed at a temp folder before it is imported.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-tune-sessions-'));
process.env.LOCALAPPDATA = root;
const sessions = await import('../electron/sessions');

const sample = fs.readFileSync(path.join(__dirname, '..', 'docs', 'phase0-presentmon-sample.csv'), 'latin1');
const { rows } = parsePresentMonCsv(sample);

beforeAll(() => expect(rows.length).toBe(10));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('the .stsession store (plan section 6)', () => {
  it('names a folder by local time and exe, and never reuses one', () => {
    const at = new Date(2026, 8, 16, 1, 5);
    const id = sessions.sessionId(at, 'Cyberpunk2077.exe');
    expect(id).toBe('2026-09-16-0105-Cyberpunk2077');
    fs.mkdirSync(path.join(sessions.sessionsDir(), id + '.stsession'), { recursive: true });
    expect(sessions.sessionId(at, 'Cyberpunk2077.exe')).toBe('2026-09-16-0105-Cyberpunk2077-2');
    fs.rmSync(path.join(sessions.sessionsDir(), id + '.stsession'), { recursive: true });
  });

  it('streams the three files, writes session.json last, and loads the folder back as a CaptureSession', async () => {
    const w = new sessions.SessionWriter(new Date(2026, 8, 16, 2, 30), 'claude.exe');
    w.writeFrames(rows.slice(0, 4));
    w.writeFrames(rows.slice(4));
    w.writeSensors([{ qpc: rows[0].timeInQpc, values: { '/amdcpu/0/power/0': 64 } }]);
    w.writeGpu({ qpc: rows[1].timeInQpc, facts: { index: 0, name: 'RTX' } as never });
    expect(fs.existsSync(path.join(w.dir, 'session.json'))).toBe(false);
    const meta = await w.finish({
      startedAt: '2026-09-16T02:30:00.000Z',
      endedAt: '2026-09-16T02:30:20.000Z',
      game: { pid: 17852, exe: 'claude.exe', path: null },
      trigger: 'manual',
      qpcFrequency: 10_000_000,
      qpcStart: rows[0].timeInQpc,
      qpcEnd: rows[9].timeInQpc,
      snapshot: null,
      hogs: { seconds: 5, logicalCpus: 32, processes: [{ pid: 7, name: 'ffmpeg.exe', cpuPercent: 30, workingSetMiB: 500 }] },
      notes: ['PresentMon exit code 0'],
      verdict: null
    });
    expect(meta.frames).toBe(10);
    expect(fs.readdirSync(w.dir).sort()).toEqual(['frames.ndjson.gz', 'gpu.ndjson.gz', 'sensors.ndjson.gz', 'session.json']);

    const listed = sessions.list();
    expect(listed.map((s) => s.id)).toEqual([w.id]);
    expect(listed[0]).toMatchObject({ exe: 'claude.exe', durationS: 20, frames: 10, hasSensors: true, verdict: null });

    const s = sessions.load(w.id);
    expect(s.frames).toEqual(rows);
    expect(s.sensorWindow?.rows).toHaveLength(1);
    expect(s.sensorWindow?.qpcNow).toBe(rows[9].timeInQpc);
    expect(s.gpuTimeline[0].facts.name).toBe('RTX');
    expect(s.hogs?.processes[0].name).toBe('ffmpeg.exe');
    expect(s.benchSummary).toBeNull();
    expect(s.notes).toEqual(['PresentMon exit code 0']);

    sessions.setVerdict(w.id, 'Smooth');
    expect(sessions.list()[0].verdict).toBe('Smooth');

    sessions.remove(w.id);
    expect(sessions.list()).toEqual([]);
    expect(fs.existsSync(path.join(sessions.sessionsDir(), '.trash', w.id + '.stsession', 'frames.ndjson.gz'))).toBe(true);
  });

  it("keeps a bench run's summary with the session and empties the trash only on request (plan section 11a)", async () => {
    const w = new sessions.SessionWriter(new Date(2026, 8, 16, 4, 0), 'strata-tune-bench.exe');
    w.writeFrames(rows);
    const segment = { name: 'cpu-stall', start: 45, end: 60, frames: 900, avgFps: 60, maxFrameMs: 95, avgGpuMs: 0.03 };
    const summary = { script: 'full', device: 'RTX', luid: 1, pid: 5, width: 1920, height: 1080, vsync: false, fpsCap: 120, vramTargetPercent: 40, completed: true, frames: 10, seconds: 90, segments: [segment], pipelineStates: 85, texturesUploaded: 60, uploadedMiB: 3840, heavyIterations: 1 };
    await w.finish({
      startedAt: '2026-09-16T04:00:00.000Z', endedAt: '2026-09-16T04:01:30.000Z',
      game: { pid: 5, exe: 'strata-tune-bench.exe', path: null }, trigger: 'bench',
      qpcFrequency: 10_000_000, qpcStart: rows[0].timeInQpc, qpcEnd: rows[9].timeInQpc,
      snapshot: null, hogs: null, notes: [], verdict: null, benchSummary: summary
    });
    expect(sessions.list()[0]).toMatchObject({ exe: 'strata-tune-bench.exe', trigger: 'bench', durationS: 90 });
    expect(JSON.parse(fs.readFileSync(path.join(w.dir, 'session.json'), 'utf-8')).benchSummary).toEqual(summary);
    // The load path hands the classifier the segment timings with their designed cases; a game capture carries none.
    const loaded = sessions.load(w.id).benchSummary;
    expect(loaded?.script).toBe('full');
    expect(loaded?.segments).toMatchObject([{ name: 'cpu-stall', startS: 45, endS: 60 }]);
    expect(typeof loaded?.segments[0].designedCause).toBe('string');

    expect(sessions.trashCount()).toBe(1);
    sessions.remove(w.id);
    expect(sessions.trashCount()).toBe(2);
    // A stray file in .trash is not ours to delete.
    fs.writeFileSync(path.join(sessions.sessionsDir(), '.trash', 'note.txt'), 'keep');
    expect(sessions.emptyTrash()).toBe(2);
    expect(sessions.trashCount()).toBe(0);
    expect(fs.readdirSync(path.join(sessions.sessionsDir(), '.trash'))).toEqual(['note.txt']);
    expect(sessions.emptyTrash()).toBe(0);
  });

  it('discards an empty capture and refuses ids that are not its own', async () => {
    const w = new sessions.SessionWriter(new Date(2026, 8, 16, 3, 0), 'nothing.exe');
    await w.discard();
    expect(fs.existsSync(w.dir)).toBe(false);
    expect(() => sessions.load('../collector')).toThrow(/Not a session id/);
    expect(() => sessions.load('.trash')).toThrow(/Not a session id/);
  });
});
