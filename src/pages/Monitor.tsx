import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Settings2, X } from 'lucide-react';
import { api, ipcErrorMessage } from '../api';
import type { StaticSnapshot, Tick } from '../collector-types';
import { useCollectorStatus } from '../components/useCollectorStatus';
import { CollectorStatusPill } from '../components/CollectorStatusPill';
import { updateSettings, useSettings } from '../components/useSettings';
import { takeIntent } from '../components/navigate';
import { SensorIndex } from '../components/monitor/sensors';
import { Ring } from '../components/monitor/history';
import { cachedSensorMeta, cachedSnapshot, clearStaticCache, refreshSensorMeta, rememberedSnapshot } from '../components/monitor/cache';
import { CpuPanel, cpuKey, cpuPowerLimit } from '../components/monitor/CpuPanel';
import { GpuPanel, gpuKey } from '../components/monitor/GpuPanel';
import { BoardPanel, BOARD_KEY, boardName } from '../components/monitor/BoardPanel';
import { SystemPower } from '../components/monitor/SystemPower';
import { panelName, type PanelChrome } from '../components/monitor/Panel';
import { cpuLimits } from '../components/monitor/cpuLimits';
import { gpuTitle } from '../components/monitor/vendors';
import { COLUMNS, isDefaultLayout, MIN_HEIGHT, movePanel, parseLayout, placeLayout, rowsOf, snapSpan, type Layout, type PanelId, type Span } from '../components/monitor/layout';

const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
/** A press that travels less than this is a click on the header, not a move. */
const DRAG_SLOP_PX = 4;

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

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const h = () => setMatches(m.matches);
    m.addEventListener('change', h);
    return () => m.removeEventListener('change', h);
  }, [query]);
  return matches;
}

interface MenuProps {
  cpuName?: string;
  layoutIsDefault: boolean;
  onClose: () => void;
}

/**
 * The page menu (items 2 and 3): the CPU power limit the sensors cannot read, and the
 * layout reset. The limit is stored as the user typed it; blank returns to stock.
 */
const PageMenu: React.FC<MenuProps> = ({ cpuName, layoutIsDefault, onClose }) => {
  const settings = useSettings();
  const limits = cpuLimits(cpuName);
  const [draft, setDraft] = useState(settings.cpuPptW === null ? '' : String(settings.cpuPptW));
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    input.current?.focus();
    // A press outside the menu closes it; the gear is left to its own toggle.
    const away = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (!box.current?.contains(t) && !t.closest('[data-menu-anchor]')) onClose();
    };
    window.addEventListener('pointerdown', away);
    return () => window.removeEventListener('pointerdown', away);
  }, [onClose]);
  const name = limits.powerName ?? 'PPT';
  const save = () => {
    const w = Number(draft);
    updateSettings({ cpuPptW: draft.trim() && Number.isFinite(w) && w > 0 ? Math.round(w) : null });
    onClose();
  };
  return (
    <div ref={box} className="absolute right-0 top-8 z-20 w-80 rounded-md border border-studio-border-light bg-studio-panel p-3 space-y-3" role="dialog" aria-label="Monitor settings">
      <div className="flex items-center justify-between">
        <span className="label text-studio-text">Monitor settings</span>
        <button className="btn-icon w-6 h-6" onClick={onClose} aria-label="Close">
          <X size={12} />
        </button>
      </div>
      <label className="block space-y-1">
        <span className="label">CPU power limit ({name})</span>
        <span className="flex items-center gap-2">
          <input
            ref={input}
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            className="figure text-[12px] w-24 h-7 px-2 rounded bg-studio-bg border border-studio-border-light text-studio-text outline-none"
            placeholder={limits.powerW ? `${limits.powerW} stock` : ''}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save();
              if (e.key === 'Escape') onClose();
            }}
          />
          <span className="figure text-[12px] text-studio-muted">W</span>
          <span className="flex-1" />
          <button className="btn" onClick={() => setDraft('')} disabled={!draft}>
            Stock
          </button>
          <button className="btn btn-accent" onClick={save}>
            Save
          </button>
        </span>
        <span className="block text-micro text-studio-subtle leading-relaxed">
          The sensors cannot read a raised PBO limit; enter the {name} you set in the BIOS or Ryzen Master{limits.powerW ? ` (stock ${limits.powerW} W)` : ''}. The Package bar and the audit judge against it.
        </span>
      </label>
      <div className="flex items-center justify-between gap-3 border-t border-studio-border pt-2">
        <span className="text-micro text-studio-subtle">Drag a header to move a panel, its corner to resize.</span>
        <button className="btn shrink-0" disabled={layoutIsDefault} onClick={() => updateSettings({ monitorLayout: null })}>
          Reset layout
        </button>
      </div>
    </div>
  );
};

interface Drag {
  id: PanelId;
  over: PanelId | null;
}

interface Resize {
  id: PanelId;
  span: Span;
  height: number;
}

/**
 * The 2 Hz instrument panel (plan 17a). Ticks are requested only while this page is
 * mounted; the 60 s ring lives with it. Plain DOM and SVG, re-rendered per tick,
 * nothing animates on its own (A6). Panels sit on a six-column grid the user arranges
 * (item 3): drag a header to move, the corner grip to resize, both with plain pointer
 * events. Every panel gets an explicit cell from placeLayout (dense packing, a two-row
 * GPU panel only while its neighbours fill both rows), so what the page models is what
 * the grid draws; the last row takes the rest of the viewport so there is no empty band.
 */
export const Monitor: React.FC = () => {
  const status = useCollectorStatus();
  const connected = status.status === 'connected';
  const settings = useSettings();
  const [index, setIndex] = useState<SensorIndex | null>(null);
  // Last launch's snapshot paints the vendor colours at once; the live one replaces it (cache.ts).
  const [snapshot, setSnapshot] = useState<StaticSnapshot | null>(rememberedSnapshot);
  const [tick, setTick] = useState<Tick | null>(null);
  const [error, setError] = useState('');
  const [menu, setMenu] = useState(() => takeIntent() === 'cpu-ppt');
  const closeMenu = useCallback(() => setMenu(false), []);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [resize, setResize] = useState<Resize | null>(null);
  const ring = useRef(new Ring()).current;
  const opened = useRef(Date.now());
  const grid = useRef<HTMLDivElement>(null);
  const wide = useMediaQuery('(min-width: 1280px)');
  const layout = useMemo(() => parseLayout(settings.monitorLayout), [settings.monitorLayout]);

  useEffect(() => {
    if (!api || !connected) {
      clearStaticCache();
      return;
    }
    const c = api.collector;
    let live = true;
    // The collector opens the sensor groups behind Tick.warming, so the list fetched at
    // connect is the CPU group and little else. Each group that opens widens the tick, so
    // a wider tick during warming means the list grew and is fetched again (the board and
    // GPU groups open within a second, the disk counters take several more); the fetch at
    // the tick that ends warming is the last one and has the complete list. Fetches can
    // resolve out of order, so only the newest one may land.
    let fetches = 0;
    const fetchMeta = (again: boolean) => {
      const seq = ++fetches;
      (again ? refreshSensorMeta() : cachedSensorMeta())
        .then((m) => live && seq === fetches && setIndex(new SensorIndex(m)))
        .catch((e) => live && setError(ipcErrorMessage(e)));
    };
    fetchMeta(false);
    cachedSnapshot()
      .then((s) => live && setSnapshot(s))
      .catch(() => {
        /* header names, vendor accents and part limits only; the panels read everything else from the ticks */
      });
    c.subscribe();
    let widest = -1;
    let warmed = false;
    const off = c.onTick((t) => {
      ring.push(t);
      if (!live) return;
      setTick(t);
      if (warmed) return;
      const width = Object.keys(t.sensors).length;
      if (t.warming && width <= widest) return;
      warmed = !t.warming;
      widest = width;
      fetchMeta(true);
    });
    return () => {
      live = false;
      off();
      c.unsubscribe();
    };
  }, [connected, ring]);

  const panelAt = (x: number, y: number): PanelId | null => {
    for (const el of grid.current?.querySelectorAll<HTMLElement>('[data-panel]') ?? []) {
      const r = el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return el.dataset.panel as PanelId;
    }
    return null;
  };

  const startMove = (id: PanelId) => (e: React.PointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX;
    const y0 = e.clientY;
    let started = false;
    let over: PanelId | null = null;
    const move = (ev: PointerEvent) => {
      if (!started && Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_SLOP_PX) return;
      started = true;
      over = panelAt(ev.clientX, ev.clientY);
      setDrag({ id, over: over === id ? null : over });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      setDrag(null);
      if (started && over && over !== id) updateSettings({ monitorLayout: movePanel(layout, id, over) });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const startResize = (id: PanelId) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const el = (e.currentTarget as HTMLElement).closest('[data-panel]') as HTMLElement | null;
    const gridEl = grid.current;
    if (!el || !gridEl) return;
    const r = el.getBoundingClientRect();
    const gridW = gridEl.getBoundingClientRect().width;
    const place = layout.find((p) => p.id === id)!;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let last: Resize = { id, span: place.span, height: Math.round(r.height) };
    const move = (ev: PointerEvent) => {
      const span = wide ? snapSpan((r.width + ev.clientX - x0) / gridW) : place.span;
      const height = Math.max(MIN_HEIGHT, Math.round(r.height + ev.clientY - y0));
      last = { id, span, height };
      setResize(last);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      setResize(null);
      // An explicit size replaces the default's two-row span: the panel is now exactly what the user drew.
      const next: Layout = layout.map((p) => (p.id === id ? { id, span: last.span, height: last.height } : p));
      updateSettings({ monitorLayout: next });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const seconds = tick ? Math.floor((Date.now() - opened.current) / 1000) : 0;
  const gpu = tick?.gpu[0] ?? snapshot?.gpus[0];
  const names = settings.panelNames;
  const cpuTitle = snapshot && index ? panelName(names, cpuKey(index), snapshot.cpu.name) : undefined;
  const gpuName = gpu ? panelName(names, gpuKey(gpu), gpuTitle(gpu)) : undefined;
  const boardTitle = snapshot ? panelName(names, BOARD_KEY, boardName(snapshot)) : undefined;
  const power = cpuPowerLimit(cpuLimits(snapshot?.cpu.name), settings.cpuPptW);

  // A resize in progress is placed as if it had landed, so the grid reflows under the pointer.
  const placed = placeLayout(resize ? layout.map((p) => (p.id === resize.id ? { id: p.id, span: resize.span, height: resize.height } : p)) : layout);
  const { rows, lastRow } = rowsOf(placed);
  /** The grid cell: its placed position and spans, and the user's height, which on the last row is a minimum so that row still takes the remainder. */
  const cellStyle = (id: PanelId): React.CSSProperties => {
    const place = placed.find((p) => p.id === id)!;
    return {
      ...(wide ? { gridColumn: `${place.col + 1} / span ${place.span}`, gridRow: `${place.row + 1} / span ${place.rows}` } : {}),
      ...(place.height !== undefined ? (lastRow.has(id) ? { minHeight: place.height } : { height: place.height }) : {})
    };
  };
  const chrome = (id: PanelId): PanelChrome => ({
    onMoveStart: startMove(id),
    onResizeStart: startResize(id),
    moving: drag?.id === id,
    target: drag?.over === id,
    fixedHeight: placed.find((p) => p.id === id)!.height !== undefined && !lastRow.has(id)
  });

  const panel = (id: PanelId): React.ReactNode => {
    if (!tick || !index) return null;
    switch (id) {
      case 'cpu':
        return <CpuPanel index={index} tick={tick} ring={ring} snapshot={snapshot} panel={chrome(id)} onOpenPowerLimit={() => setMenu(true)} />;
      case 'gpu':
        return <GpuPanel index={index} tick={tick} ring={ring} panel={chrome(id)} />;
      case 'power':
        return <SystemPower index={index} tick={tick} ring={ring} snapshot={snapshot} panel={chrome(id)} />;
      case 'board':
        return <BoardPanel index={index} tick={tick} ring={ring} snapshot={snapshot} panel={chrome(id)} />;
    }
  };

  return (
    <div className="p-3 flex-1 flex flex-col gap-3 min-w-0">
      <header className="relative flex flex-wrap items-center gap-x-4 gap-y-1 px-1 min-w-0">
        <HeaderItem label="CPU" value={cpuTitle} />
        <HeaderItem label="GPU" value={gpuName} />
        <HeaderItem label="Board" value={boardTitle} />
        <span className="flex-1" />
        {power.watts && !power.stock && (
          <span className="label text-studio-subtle" title="The CPU power limit you set; the Package bar is judged against it">
            {power.name} {power.watts} W
          </span>
        )}
        <span className="figure text-[12px] text-studio-muted" title="Time on this page">
          {mmss(seconds)}
        </span>
        <CollectorStatusPill state={status} />
        <button className="btn-icon" data-menu-anchor onClick={() => setMenu((m) => !m)} title="Monitor settings: CPU power limit, layout" aria-label="Monitor settings" aria-expanded={menu}>
          <Settings2 size={14} />
        </button>
        {menu && <PageMenu cpuName={snapshot?.cpu.name} layoutIsDefault={isDefaultLayout(layout)} onClose={closeMenu} />}
      </header>

      {!connected ? (
        <Notice>{status.message}</Notice>
      ) : error ? (
        <Notice tone="bad">{error}</Notice>
      ) : !tick || !index ? (
        <Notice>Waiting for the first sample…</Notice>
      ) : (
        <div
          ref={grid}
          className={`grid gap-3 min-w-0 flex-1 ${drag ? 'select-none' : ''}`}
          style={{
            gridTemplateColumns: wide ? `repeat(${COLUMNS}, minmax(0, 1fr))` : 'minmax(0, 1fr)',
            gridTemplateRows: wide && rows > 1 ? `repeat(${rows - 1}, auto) 1fr` : undefined,
            cursor: drag ? 'grabbing' : resize ? 'nwse-resize' : undefined
          }}
        >
          {layout.map((p) => (
            <div key={p.id} data-panel={p.id} className="min-w-0 min-h-0" style={cellStyle(p.id)}>
              {panel(p.id)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
