import { describe, expect, it } from 'vitest';
import { BATTERY_POLL_MS, GPU_MEMORY_POLL_MS, IDLE_MS, LEASED_MS, MacSensors, type MacmonSample } from '../electron/mac/sensors';

/**
 * A system monitor must itself be cheap (electron/mac/sensors.ts): with no reader the macOS
 * collector samples macmon every 5 s and leaves the GPU memory unread; a lease (the Monitor, a
 * load run, Measure, the LLM benchmark) brings it to 500 ms with the 2 s GPU memory read; the
 * battery is read every 30 s either way. Every macmon line is one tick, never a timer's repeat.
 */
const sample = (cpu: number): MacmonSample => ({ cpu_power: cpu, gpu_power: 1, pcpu_cores: [{ core_id: 0, freq_mhz: 4000, active_ratio: 0.5 }], ecpu_cores: [] });
const sensors = (over: Partial<ConstructorParameters<typeof MacSensors>[0]> = {}) =>
  new MacSensors({ macmon: '/opt/homebrew/bin/macmon', chip: 'Apple Test', gpuTotalMiB: 768, pollers: false, lingerMs: 0, ...over });

describe('sensor leases', () => {
  it('idles at 5 s with no GPU memory read, runs at 500 ms with it while any lease is held, and drops back when the last goes', () => {
    const s = sensors();
    s.start();
    expect(s.rate).toBe('idle');
    expect(s.schedule).toEqual({ macmonMs: IDLE_MS, gpuMemoryMs: null, batteryMs: BATTERY_POLL_MS, fallbackTickMs: null });
    const monitor = s.acquire('monitor');
    const load = s.acquire('load heavy');
    expect(s.rate).toBe('leased');
    expect(s.schedule).toEqual({ macmonMs: LEASED_MS, gpuMemoryMs: GPU_MEMORY_POLL_MS, batteryMs: BATTERY_POLL_MS, fallbackTickMs: null });
    expect(s.leaseReasons).toEqual(['monitor', 'load heavy']);
    monitor.release();
    monitor.release();
    expect(s.rate).toBe('leased');
    load.release();
    expect(s.rate).toBe('idle');
    expect(s.schedule.gpuMemoryMs).toBeNull();
    s.stop();
  });

  it('the leased rate lingers briefly after the last lease, so a page switch does not restart macmon twice', async () => {
    const s = sensors({ lingerMs: 40 });
    s.start();
    s.acquire('monitor').release();
    expect(s.rate).toBe('leased');
    const again = s.acquire('monitor');
    await new Promise((r) => setTimeout(r, 60));
    expect(s.rate).toBe('leased');
    again.release();
    await new Promise((r) => setTimeout(r, 60));
    expect(s.rate).toBe('idle');
    s.stop();
  });

  it('every fed macmon line is one tick; a lease waits for a sample from the leased rate before whenFresh resolves', async () => {
    const s = sensors();
    const ticks: number[] = [];
    s.on('tick', (row: { values: Record<string, number> }) => ticks.push(row.values['/apple/cpu/0/power/package']));
    s.start();
    s.feed(sample(3));
    expect(ticks).toEqual([3]);
    const lease = s.acquire('load cpu');
    let fresh = false;
    const waiting = s.whenFresh(1000).then(() => (fresh = true));
    await Promise.resolve();
    expect(fresh).toBe(false);
    s.feed(sample(7));
    await waiting;
    expect(fresh).toBe(true);
    expect(ticks).toEqual([3, 7]);
    // Already fresh: at once.
    await s.whenFresh(1000);
    lease.release();
    expect(s.warming).toBe(false);
    s.stop();
  });

  it('without macmon a timer paces the rows at the same two rates, and nothing waits for a fresh sample', async () => {
    const s = sensors({ macmon: null, tickMs: 10, idleTickMs: 1000 });
    expect(s.warming).toBe(false);
    expect(s.schedule.fallbackTickMs).toBe(1000);
    let n = 0;
    s.on('tick', () => n++);
    s.start();
    await s.whenFresh(5000);
    s.acquire('monitor');
    expect(s.schedule.fallbackTickMs).toBe(10);
    await new Promise((r) => setTimeout(r, 60));
    expect(n).toBeGreaterThan(2);
    s.stop();
  });

  it('the soc-info line seeds the rows while the 5 s idle stream has given none, and never counts as fresh', async () => {
    const s = sensors();
    s.start();
    s.seed(sample(4));
    expect(s.value('/apple/cpu/0/power/package')).toBe(4);
    expect(s.warming).toBe(false);
    s.feed(sample(6));
    s.seed(sample(9));
    expect(s.value('/apple/cpu/0/power/package')).toBe(6);
    const fresh = sensors();
    fresh.start();
    fresh.acquire('llm benchmark');
    fresh.seed(sample(4));
    let done = false;
    const waiting = fresh.whenFresh(1000).then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    fresh.feed(sample(5));
    await waiting;
    s.stop();
    fresh.stop();
  });

  it('warms until the chip facts arrive when they are read after the collector listens', () => {
    const s = sensors({ factsPending: true, gpuTotalMiB: null });
    s.feed(sample(5));
    expect(s.warming).toBe(true);
    expect(s.meta().some((m) => m.name === 'GPU Memory Total')).toBe(false);
    s.setFacts('Apple M5 Max', { gpuName: 'Apple M5 Max (40-core GPU)', coreLabels: { high: 'S', low: 'P' }, gpuCores: 40 }, 38_338);
    expect(s.warming).toBe(false);
    expect(s.meta().some((m) => m.name === 'S-Core #1')).toBe(true);
    expect(s.meta().some((m) => m.name === 'GPU Memory Total' && m.hardwareName === 'Apple M5 Max (40-core GPU)')).toBe(true);
  });
});
