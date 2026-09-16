import React, { useEffect, useRef, useState } from 'react';
import { api, ipcErrorMessage } from '../api';
import type { StaticSnapshot, Tick } from '../collector-types';
import { useCollectorStatus } from '../components/useCollectorStatus';
import { CollectorStatusPill } from '../components/CollectorStatusPill';
import { SensorIndex } from '../components/monitor/sensors';
import { Ring } from '../components/monitor/history';
import { cachedSensorMeta, cachedSnapshot, clearStaticCache } from '../components/monitor/cache';
import { CpuPanel } from '../components/monitor/CpuPanel';
import { GpuPanel } from '../components/monitor/GpuPanel';
import { BoardPanel } from '../components/monitor/BoardPanel';
import { SystemPower } from '../components/monitor/SystemPower';

const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

/** WMI's CPU string carries a trailing "16-Core Processor" that says nothing the grid does not. */
const shortName = (name?: string) => name?.replace(/\s+\d+-Core Processor$/i, '').replace(/\(R\)|\(TM\)/g, '').replace(/\s{2,}/g, ' ').trim();

const HeaderItem: React.FC<{ label: string; value?: string }> = ({ label, value }) =>
  value ? (
    <span className="inline-flex items-baseline gap-1.5 min-w-0">
      <span className="label">{label}</span>
      <span className="figure text-[12px] text-studio-text truncate">{value}</span>
    </span>
  ) : null;

const Notice: React.FC<{ tone?: 'muted' | 'bad'; children: React.ReactNode }> = ({ tone = 'muted', children }) => (
  <div className={`rounded-md border px-3 py-2 text-mini ${tone === 'bad' ? 'border-rose-500/40 bg-rose-500/10 text-rose-200' : 'border-studio-border bg-studio-panel/50 text-studio-muted'}`}>{children}</div>
);

/**
 * The 2 Hz instrument panel (plan 17a). Ticks are requested only while this
 * page is mounted; the 60 s ring lives with it. Plain DOM and SVG, re-rendered
 * per tick, nothing animates on its own (A6). At xl the GPU panel is the tall
 * one and spans two rows; the CPU panel and the system-power row share the left
 * column beside it, and the board spans the width beneath.
 */
export const Monitor: React.FC = () => {
  const status = useCollectorStatus();
  const connected = status.status === 'connected';
  const [index, setIndex] = useState<SensorIndex | null>(null);
  const [snapshot, setSnapshot] = useState<StaticSnapshot | null>(null);
  const [tick, setTick] = useState<Tick | null>(null);
  const [error, setError] = useState('');
  const ring = useRef(new Ring()).current;
  const opened = useRef(Date.now());

  useEffect(() => {
    if (!api || !connected) {
      clearStaticCache();
      return;
    }
    const c = api.collector;
    let live = true;
    cachedSensorMeta()
      .then((m) => live && setIndex(new SensorIndex(m)))
      .catch((e) => live && setError(ipcErrorMessage(e)));
    cachedSnapshot()
      .then((s) => live && setSnapshot(s))
      .catch(() => {
        /* header names, vendor accents and part limits only; the panels read everything else from the ticks */
      });
    c.subscribe();
    const off = c.onTick((t) => {
      ring.push(t);
      if (live) setTick(t);
    });
    return () => {
      live = false;
      off();
      c.unsubscribe();
    };
  }, [connected, ring]);

  const seconds = tick ? Math.floor((Date.now() - opened.current) / 1000) : 0;

  return (
    <div className="p-3 space-y-3 min-w-0">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 min-w-0">
        <HeaderItem label="CPU" value={shortName(snapshot?.cpu.name)} />
        <HeaderItem label="GPU" value={tick?.gpu[0]?.name ?? snapshot?.gpus[0]?.name} />
        <HeaderItem label="Board" value={snapshot?.motherboard.product} />
        <span className="flex-1" />
        <span className="figure text-[12px] text-studio-muted" title="Time on this page">
          {mmss(seconds)}
        </span>
        <CollectorStatusPill state={status} />
      </header>

      {!connected ? (
        <Notice>{status.message}</Notice>
      ) : error ? (
        <Notice tone="bad">{error}</Notice>
      ) : !tick || !index ? (
        <Notice>Waiting for the first sample…</Notice>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 min-w-0 xl:items-start">
          <CpuPanel index={index} tick={tick} ring={ring} snapshot={snapshot} />
          <GpuPanel index={index} tick={tick} ring={ring} />
          <SystemPower index={index} tick={tick} ring={ring} snapshot={snapshot} />
          <BoardPanel index={index} tick={tick} ring={ring} snapshot={snapshot} />
        </div>
      )}
    </div>
  );
};
