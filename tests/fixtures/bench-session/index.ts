/**
 * A real full-script bench run on the dev box (2026-09-16, RTX 5090, 1920×1080), the
 * session the "Engine stall" report came from, trimmed: every frame and GPU reading is
 * kept, the sensor rows are cut to the disk queues (the one sensor the classifier
 * reads), the process sample to its top eight, and the snapshot's board line is gone.
 * The folder is laid out like a .stsession, so this loader mirrors electron/sessions.ts.
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as zlib from 'zlib';
import type { HogsResult, SensorRow, StaticSnapshot } from '../../../src/collector-types';
import { benchSegments } from '../../../src/analysis/stutter';
import type { CaptureSession, FrameRow, GpuSample } from '../../../src/analysis/session-types';

const DIR = path.dirname(fileURLToPath(import.meta.url));

interface Meta {
  id: string;
  startedAt: string;
  game: CaptureSession['game'];
  qpcFrequency: number;
  qpcEnd: number;
  snapshot: StaticSnapshot | null;
  hogs: HogsResult | null;
  notes: string[];
  /** The headline the app stored when it analysed this session: the report the user saw. */
  verdict: string;
  benchSummary: { script: string; segments: { name: string; start: number; end: number }[] };
}

function rows<T>(file: string): T[] {
  return zlib.gunzipSync(fs.readFileSync(path.join(DIR, file))).toString('utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as T);
}

export const benchMeta = (): Meta => JSON.parse(fs.readFileSync(path.join(DIR, 'session.json'), 'utf-8')) as Meta;

/** The session as the app loads it; `withSummary: false` is today's load path, where session.json's benchSummary does not reach the analysis. */
export function benchSession(withSummary = true): CaptureSession {
  const meta = benchMeta();
  const sensors = rows<SensorRow>('sensors.ndjson.gz');
  return {
    id: meta.id,
    startedAt: meta.startedAt,
    game: meta.game,
    qpcFrequency: meta.qpcFrequency,
    frames: rows<FrameRow>('frames.ndjson.gz'),
    sensorWindow: { seconds: 90, qpcNow: meta.qpcEnd, rows: sensors, summaries: [] },
    snapshot: meta.snapshot,
    gpuTimeline: rows<GpuSample>('gpu.ndjson.gz'),
    hogs: meta.hogs,
    notes: meta.notes,
    benchSummary: withSummary ? { script: meta.benchSummary.script, segments: benchSegments(meta.benchSummary.segments) } : null
  };
}
