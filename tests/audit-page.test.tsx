import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CollectorApi } from '../src/api';
import type { LoadKind, LoadRun } from '../src/collector-types';
import { devbox, loadRun } from './fixtures';

// Outside Electron: no window.strata; the page's pieces are rendered with a fake collector API instead.
vi.mock('../src/api', () => ({ api: undefined, inElectron: false, ipcErrorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)) }));

/** The renderer's localStorage, enough of it for settings.ts inside the runner. */
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k)
};

const { auditRun, STEPS } = await import('../src/components/audit/run');
const { AuditProgress, AuditResultView, reportText, visibleFindings } = await import('../src/pages/Audit');

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * A collector whose load runs hang until told: `finish(kind)` ends one as done, `cancelLoad`
 * ends the one in flight as cancelled the way the real client does once the collector's
 * POST /load/{id}/cancel has answered.
 */
function fakeCollector() {
  const calls: string[] = [];
  const pending = new Map<LoadKind, (run: LoadRun) => void>();
  // The fixture predates the NVAPI unit counts; with the ROPs known the run is the five plain steps, no fill-rate cross-check.
  const snapshot = devbox();
  snapshot.gpus[0].units = { shaders: 21760, sms: 170, rops: 176, tmus: 680, source: 'nvapi' };
  const c = {
    snapshot: () => {
      calls.push('snapshot');
      return Promise.resolve(snapshot);
    },
    hogs: () => {
      calls.push('hogs');
      return Promise.resolve({ seconds: 5, logicalCpus: 32, processes: [] });
    },
    load: (kind: LoadKind, seconds: number) => {
      calls.push(`load ${kind}`);
      return new Promise<LoadRun>((resolve) => pending.set(kind, (run) => resolve({ ...run, kind, seconds })));
    },
    cancelLoad: () => {
      calls.push('cancelLoad');
      const [kind, resolve] = [...pending.entries()][0] ?? [];
      if (!kind || !resolve) return Promise.resolve(false);
      pending.delete(kind);
      resolve({ ...loadRun(kind, 1), state: 'cancelled', exitCode: -1 });
      return Promise.resolve(true);
    }
  } as unknown as CollectorApi;
  const finish = (kind: LoadKind) => {
    const resolve = pending.get(kind)!;
    pending.delete(kind);
    resolve(loadRun(kind, 1));
  };
  return { c, calls, finish };
}

describe('audit run with Stop (plan section 17c)', () => {
  it('a full run visits every step in order and is not interrupted', async () => {
    const { c, calls, finish } = fakeCollector();
    const seen: number[] = [];
    const r = auditRun(c, (_steps, step) => seen.push(step));
    for (const kind of ['light', 'heavy', 'cpu'] as const) {
      while (!calls.includes(`load ${kind}`)) await tick();
      finish(kind);
    }
    const result = await r.done;
    expect(seen).toEqual([0, 1, 2, 3, 4]);
    expect(calls).toEqual(['snapshot', 'hogs', 'load light', 'load heavy', 'load cpu']);
    expect(result.interrupted).toBeNull();
    expect(result.machine).toContain('9950X');
    expect(result.findings.length).toBeGreaterThan(10);
  });

  it('Stop during the light load cancels it on the collector, skips the heavy and CPU steps, and judges the checks that have their inputs', async () => {
    const { c, calls } = fakeCollector();
    const r = auditRun(c, () => {});
    while (!calls.includes('load light')) await tick();
    r.stop();
    r.stop();
    const result = await r.done;
    expect(calls).toEqual(['snapshot', 'hogs', 'load light', 'cancelLoad']);
    expect(result.interrupted).toEqual({ step: 3, of: STEPS.length, label: 'PCIe link under a light load' });
    // The cancelled run is not a failure: nothing in the Skipped box.
    expect(result.skipped).toEqual([]);
    // Snapshot checks are judged; the ones fed by the steps that did not run read unknown and are counted, not listed.
    const shown = visibleFindings(result);
    expect(shown.some((f) => f.id === 'expo' || f.id === 'rebar')).toBe(true);
    expect(shown.every((f) => f.state !== 'unknown')).toBe(true);
    expect(result.findings.find((f) => f.id === 'thermal-headroom')?.state).toBe('unknown');
    expect(result.findings.find((f) => f.id === 'cpu-thermal')?.state).toBe('unknown');
    expect(result.findings.length).toBeGreaterThan(shown.length);
    expect(reportText(result)).toContain('Interrupted at step 3 of 5 (PCIe link under a light load); the steps after it did not run.');
  });

  it('Stop while the snapshot is being read leaves nothing to judge and says so', async () => {
    const { c } = fakeCollector();
    const r = auditRun(c, () => {});
    r.stop();
    const result = await r.done;
    expect(result.interrupted).toEqual({ step: 1, of: STEPS.length, label: 'Reading the system snapshot' });
    expect(result.findings).toEqual([]);
    expect(result.machine).toBe('');
  });

  it('a step that fails on its own is skipped with its reason, and the run goes on', async () => {
    const { c, calls, finish } = fakeCollector();
    c.hogs = () => Promise.reject(new Error('hogs answered 500'));
    const r = auditRun(c, () => {});
    for (const kind of ['light', 'heavy', 'cpu'] as const) {
      while (!calls.includes(`load ${kind}`)) await tick();
      finish(kind);
    }
    const result = await r.done;
    expect(result.skipped).toEqual(['Sampling idle background load: hogs answered 500']);
    expect(result.interrupted).toBeNull();
  });
});

describe('audit page pieces', () => {
  it('the progress box carries Stop from the first second, beside the step line', () => {
    const html = renderToStaticMarkup(<AuditProgress running={{ steps: STEPS, step: 0, stepStartedAt: 1000 }} now={1000} onStop={() => {}} />);
    expect(html).toContain('Step 1 of 5: Reading the system snapshot');
    expect(html).toContain('0 / ~50 s');
    expect(html).toContain('Stop</button>');
    expect(html).toContain('(Escape)');
  });

  it('an interrupted result shows the banner with Run again, the completed checks only, and "Stopped" for the time line', () => {
    const findings = [
      { id: 'expo', title: 'EXPO', state: 'ok' as const, severity: 0 as const, costEstimate: 0, costText: '', detail: '', fix: '', fixWhere: 'none' as const },
      { id: 'thermal', title: 'Thermal headroom', state: 'unknown' as const, severity: 0 as const, costEstimate: 0, costText: '', detail: 'The heavy load did not run.', fix: '', fixWhere: 'none' as const }
    ];
    const saved = { at: '2026-09-16T20:00:00Z', machine: 'box', findings, skipped: [], interrupted: { step: 4, of: 5, label: 'Thermal headroom under a heavy load' } };
    const html = renderToStaticMarkup(<AuditResultView saved={saved} canRun onRun={() => {}} />);
    expect(html).toContain('Interrupted at step 4 of 5 (Thermal headroom under a heavy load). The 1 check that completed is below; 1 read unknown without the steps that did not run.');
    expect(html).toContain('Run again');
    expect(html).toContain('EXPO');
    expect(html).not.toContain('Thermal headroom</h3>');
    expect(html).toContain('Stopped ');
    // The same result complete lists the unknown too and reads "Last run".
    const complete = renderToStaticMarkup(<AuditResultView saved={{ ...saved, interrupted: null }} canRun onRun={() => {}} />);
    expect(complete).toContain('Thermal headroom</h3>');
    expect(complete).toContain('Last run ');
    expect(complete).not.toContain('Interrupted');
  });
});
