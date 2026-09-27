import { describe, expect, it, vi } from 'vitest';
import { BATTERY_POLL_MS, GPU_MEMORY_IDLE_POLL_MS, GPU_MEMORY_POLL_MS, IDLE_MS, IDS, LEASED_MS, MacSensors, type MacmonSample } from '../electron/mac/sensors';

/**
 * A system monitor must itself be cheap (electron/mac/sensors.ts): with no reader the macOS
 * collector samples macmon every 5 s and reads the GPU memory every 10 s; a lease (the Monitor, a
 * load run, Measure, the LLM benchmark) brings it to 500 ms with the 2 s GPU memory read; the
 * battery is read every 30 s either way. Every macmon line is one tick, never a timer's repeat.
 */
const sample = (cpu: number): MacmonSample => ({ cpu_power: cpu, gpu_power: 1, pcpu_cores: [{ core_id: 0, freq_mhz: 4000, active_ratio: 0.5 }], ecpu_cores: [] });
const sensors = (over: Partial<ConstructorParameters<typeof MacSensors>[0]> = {}) =>
  new MacSensors({ macmon: '/opt/homebrew/bin/macmon', chip: 'Apple Test', gpuTotalMiB: 768, pollers: false, lingerMs: 0, ...over });

describe('sensor leases', () => {
  it('idles at 5 s with a 10 s GPU memory read, runs at 500 ms with a 2 s one while any lease is held, and drops back when the last goes', () => {
    const s = sensors();
    s.start();
    expect(s.rate).toBe('idle');
    expect(s.schedule).toEqual({ macmonMs: IDLE_MS, gpuMemoryMs: GPU_MEMORY_IDLE_POLL_MS, batteryMs: BATTERY_POLL_MS, fallbackTickMs: IDLE_MS });
    const monitor = s.acquire('monitor');
    const load = s.acquire('load heavy');
    expect(s.rate).toBe('leased');
    expect(s.schedule).toEqual({ macmonMs: LEASED_MS, gpuMemoryMs: GPU_MEMORY_POLL_MS, batteryMs: BATTERY_POLL_MS, fallbackTickMs: LEASED_MS });
    expect(s.leaseReasons).toEqual(['monitor', 'load heavy']);
    monitor.release();
    monitor.release();
    expect(s.rate).toBe('leased');
    load.release();
    expect(s.rate).toBe('idle');
    expect(s.schedule.gpuMemoryMs).toBe(GPU_MEMORY_IDLE_POLL_MS);
    s.stop();
  });

  it('reads the GPU memory at once when armed and when a lease comes, every 10 s with none, and keeps the reading when the lease goes', () => {
    vi.useFakeTimers();
    const proto = MacSensors.prototype as unknown as { pollGpuMemory(): void; pollBattery(): void };
    const poll = vi.spyOn(proto, 'pollGpuMemory').mockImplementation(() => {});
    vi.spyOn(proto, 'pollBattery').mockImplementation(() => {});
    try {
      const s = sensors({ macmon: null, pollers: true });
      s.start();
      expect(poll).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(GPU_MEMORY_IDLE_POLL_MS);
      expect(poll).toHaveBeenCalledTimes(2);
      const lease = s.acquire('monitor');
      expect(poll).toHaveBeenCalledTimes(3);
      vi.advanceTimersByTime(GPU_MEMORY_POLL_MS);
      expect(poll).toHaveBeenCalledTimes(4);
      lease.release();
      expect(poll).toHaveBeenCalledTimes(4);
      vi.advanceTimersByTime(GPU_MEMORY_IDLE_POLL_MS - 1);
      expect(poll).toHaveBeenCalledTimes(4);
      vi.advanceTimersByTime(1);
      expect(poll).toHaveBeenCalledTimes(5);
      s.stop();
      vi.advanceTimersByTime(GPU_MEMORY_IDLE_POLL_MS);
      expect(poll).toHaveBeenCalledTimes(5);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
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

  it('with macmon installed but printing nothing the timer paces the rows, and never while its lines arrive', async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const s = sensors({ tickMs: 50, idleTickMs: 50 });
    let n = 0;
    s.on('tick', () => n++);
    s.start();
    // Healthy: one tick per line and none from the timer, also while a restarted macmon (a lease) has not printed yet.
    for (let i = 0; i < 8; i++) {
      s.feed(sample(3));
      await sleep(10);
    }
    const monitor = s.acquire('monitor');
    await sleep(80);
    s.feed(sample(3));
    expect(n).toBe(9);
    // Silent (a crash loop): after three intervals the timer ticks, with the live IOKit rows and not the dead sample's readings.
    await sleep(400);
    expect(n).toBeGreaterThanOrEqual(11);
    expect(s.value(IDS.gpuMemTotalMiB)).toBe(768);
    expect(s.value(IDS.cpuPackageW)).toBeNull();
    expect(s.meta().some((m) => m.id === IDS.cpuPackageW)).toBe(true);
    // Nothing waits for a fresh sample that is not coming, a lease's restart included.
    monitor.release();
    s.acquire('load cpu');
    const asked = Date.now();
    await s.whenFresh(2000);
    expect(Date.now() - asked).toBeLessThan(100);
    // A line brings the readings back.
    s.feed(sample(8));
    expect(s.value(IDS.cpuPackageW)).toBe(8);
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
