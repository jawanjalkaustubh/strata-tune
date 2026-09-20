import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CollectorClient } from '../electron/collector';
import { MacCollector, NOT_ON_APPLE_SILICON } from '../electron/mac/server';
import { MacSensors } from '../electron/mac/sensors';
import type { Handshake, Health, SensorMeta, StaticSnapshot, Tick, TuneStatus } from '../src/collector-types';

/**
 * The macOS collector over the real wire, driven by the real CollectorClient: the routes, the
 * bearer token, the SSE ticks and the load-run cancel semantics that tests/load-cancel.test.ts
 * pins for the Windows service. The worker is a shell script that sleeps, so a "load" is
 * a process that can be killed; the sensors are fed a sample instead of running macmon.
 */
const sample = { cpu_power: 5, gpu_power: 1, pcpu_cores: [{ core_id: 0, freq_mhz: 4000, active_ratio: 0.5 }], ecpu_cores: [], gpu_freq_mhz: 500, gpu_active_ratio: 0.1, fans: [], memory: { ram_total: 1000, ram_usage: 400, swap_total: 0, swap_usage: 0 }, temp: { cpu_temp_avg: 50, gpu_temp_avg: 45 } };

const SNAPSHOT: StaticSnapshot = {
  capturedAt: '2026-09-20T00:00:00Z',
  os: { caption: 'macOS test', build: '0' },
  chassis: { isLaptop: true, chassisTypes: [] },
  cpu: { name: 'Apple Test', family: 0, model: 0, cores: 1, logical: 1, maxClockMhz: 4000 },
  motherboard: { manufacturer: 'Apple', product: 'Test', biosVersion: '', biosDate: '' },
  ram: { totalMiB: 1024, modules: [] },
  gpus: [],
  gpuDriver: { version: 'Metal', date: null },
  powerPlan: { guid: '', name: 'Automatic', overlayGuid: null },
  disks: [],
  volumes: [],
  ollama: null,
  adapters: [{ name: 'Apple Test', vendor: 'apple', dedicatedMiB: 768, driverVersion: 'Metal', driverDate: null, integrated: false }],
  battery: { present: true, onAc: true, percent: 50 }
};

const tick = (ms = 50) => new Promise<void>((r) => setTimeout(r, ms));

describe('the macOS collector over the wire', () => {
  let dir: string;
  let mac: MacCollector;
  let h: Handshake;
  const client = () => {
    const c = new CollectorClient();
    Object.assign(c, { handshake: h });
    c.state = { status: 'connected', message: 'test' };
    return c;
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'strata-tune-mac-'));
    const worker = join(dir, 'fake-worker.sh');
    writeFileSync(worker, '#!/bin/sh\n[ "$1" = "--info" ] && { echo \'{"device":"Apple Test","luid":"1","unified":true,"recommendedMaxWorkingSetBytes":805306368,"maxBufferBytes":1}\'; exit 0; }\nsleep "$4"\n');
    chmodSync(worker, 0o755);
    const sensors = new MacSensors({ macmon: null, chip: 'Apple Test', gpuTotalMiB: 768, pollers: false, tickMs: 20 });
    mac = new MacCollector({ version: 'test', dataDir: dir, workerPath: worker, macmonPath: null, sensors, snapshot: () => Promise.resolve(SNAPSHOT), logicalCpus: 4 });
    h = await mac.start();
    mac.feed(sample);
  });
  afterAll(() => mac.stop());

  it('writes the handshake and answers /health with its own pid, no elevation and the microsecond clock', async () => {
    const c = client();
    const health = await c.get<Health>('/health');
    expect(health).toMatchObject({ ok: true, pid: process.pid, elevated: false, qpcFrequency: 1_000_000, nvml: { available: false } });
    expect(h.pid).toBe(process.pid);
    expect(h.token).toHaveLength(64);
  });

  it('refuses a request without the token', async () => {
    const r = await fetch(`http://127.0.0.1:${h.port}/health`);
    expect(r.status).toBe(401);
  });

  it('serves the sensor list, the latest row, a window and the snapshot', async () => {
    await tick(60);
    const c = client();
    const meta = await c.sensorsMeta();
    expect(meta.some((m: SensorMeta) => m.hardwareType === 'Cpu' && m.name === 'P-Core #1')).toBe(true);
    const latest = await c.sensorsLatest();
    expect(Object.keys(latest.values).length).toBe(meta.length);
    const window = await c.sensorsWindow(10);
    expect(window.rows.length).toBeGreaterThan(0);
    expect(await c.snapshot()).toEqual(SNAPSHOT);
    expect(await c.gpu()).toEqual([]);
  });

  it('streams tick events the client parses', async () => {
    const c = client();
    const got = new Promise<Tick>((resolve) => c.once('tick', resolve));
    (c as unknown as { openStream: () => void }).openStream();
    const t = await got;
    expect(t.gpu).toEqual([]);
    expect(typeof t.qpc).toBe('number');
    expect(t.sensors['/apple/cpu/0/power/package']).toBe(5);
    (c as unknown as { stream: { destroy: () => void } | null }).stream?.destroy();
  });

  it('a load run can be cancelled: the pending load() resolves cancelled, a second cancel is 409, an unknown id 404', async () => {
    const c = client();
    const pending = c.load('light', 5);
    await tick(100);
    expect(await c.cancelLoad()).toBe(true);
    const run = await pending;
    expect(run.state).toBe('cancelled');
    expect(run.error).toBeNull();
    expect(run.gpuSamples.length).toBeGreaterThan(0);
    await expect(c.post(`/load/${run.id}/cancel`, undefined)).rejects.toThrow(/409/);
    await expect(c.post('/load/nope/cancel', undefined)).rejects.toThrow(/404/);
  });

  it('a short load run finishes on its own as done, with the idle CPU reference first for the cpu kind', async () => {
    const c = client();
    const run = await c.load('cpu', 1);
    expect(run.state).toBe('done');
    expect(run.exitCode).toBe(0);
    expect(run.cpuSamples.length).toBeGreaterThanOrEqual(2);
    expect(run.cpuSamples[0].packageW).toBe(5);
  });

  it('refuses a bad load request and a second run while one is going', async () => {
    const c = client();
    await expect(c.post('/load', { kind: 'nope', seconds: 1 })).rejects.toThrow(/400/);
    const pending = c.load('heavy', 5);
    await tick(50);
    await expect(c.post('/load', { kind: 'light', seconds: 1 })).rejects.toThrow(/409/);
    await c.cancelLoad();
    await pending;
  });

  it('the tune routes say why there is no hunt on Apple Silicon', async () => {
    const c = client();
    const status = await c.get<TuneStatus>('/tune/state');
    expect(status.nvapi).toMatchObject({ available: false, reason: NOT_ON_APPLE_SILICON });
    await expect(c.post('/tune/start', { kind: 'hunt', enabled: true })).rejects.toThrow(/403/);
    await expect(c.get('/tune/export')).rejects.toThrow(/404/);
  });

  it('answers 404 for an unknown route and 202 for shutdown', async () => {
    const c = client();
    await expect(c.get('/nothing')).rejects.toThrow(/404/);
    expect(await c.shutdown()).toBe(true);
    await tick(50);
    expect(mac.handshake).toBeNull();
  });
});
