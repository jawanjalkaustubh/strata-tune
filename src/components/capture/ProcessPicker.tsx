import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { api, type ProcessPick } from '../../api';
import benchmarks from '../../data/benchmarks.json';

/** What Start will run: the built-in bench, or one windowed process. */
export type Pick = { kind: 'bench' } | { kind: 'process'; pid: number; exe: string; title: string };

export const BENCH_PICK: Pick = { kind: 'bench' };
export const BENCH_LABEL: string = benchmarks.builtIn.label;

const REFRESH_MS = 3000;
const TITLE_MAX = 44;

const trim = (t: string) => (t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX)}…` : t);

/** The button's text for the current pick. */
export function pickLabel(p: Pick): string {
  return p.kind === 'bench' ? BENCH_LABEL : `${p.exe}${p.title ? ` · ${trim(p.title)}` : ''}`;
}

type Row = { id: string; pick: Pick; process?: ProcessPick };

/** The list once the "Show all" fold is applied, in the order the keys walk it. */
function rows(processes: ProcessPick[], showAll: boolean): Row[] {
  const out: Row[] = [{ id: 'bench', pick: BENCH_PICK }];
  for (const p of processes) {
    if (p.group === 'other' && !showAll) continue;
    out.push({ id: `p${p.pid}`, pick: { kind: 'process', pid: p.pid, exe: p.exe, title: p.title }, process: p });
  }
  return out;
}

const samePick = (a: Pick, b: Pick) => a.kind === b.kind && (a.kind === 'bench' || (b.kind === 'process' && a.pid === b.pid));

const Group: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div role="group" aria-label={title}>
    <div className="label px-2 pt-2 pb-1 text-studio-subtle">{title}</div>
    {children}
  </div>
);

const Option: React.FC<{ row: Row; active: boolean; selected: boolean; onPick: () => void; onHover: () => void }> = ({ row, active, selected, onPick, onHover }) => {
  const p = row.process;
  return (
    <div
      id={`pick-${row.id}`}
      role="option"
      aria-selected={selected}
      className={`flex items-baseline gap-2 px-2 h-7 cursor-pointer rounded-control min-w-0 ${active ? 'bg-studio-panel-hi text-studio-text' : selected ? 'text-studio-accent' : 'text-studio-muted'}`}
      onMouseEnter={onHover}
      onClick={onPick}
    >
      {p ? (
        <>
          <span className="figure text-[12px] shrink-0">{p.exe}</span>
          <span className="text-mini truncate min-w-0" title={p.title}>
            {p.title}
          </span>
          <span className="flex-1" />
          {p.source && <span className="label text-studio-subtle shrink-0">{p.source}</span>}
          {p.path === null && (
            <span className="label text-studio-subtle shrink-0" title="The process runs elevated or under anti-cheat, so its path could not be read; only its name is known">
              path not readable
            </span>
          )}
          <span className="figure text-[11px] text-studio-subtle shrink-0">{p.pid}</span>
        </>
      ) : (
        <>
          <span className="text-mini">{BENCH_LABEL}</span>
          <span className="flex-1" />
          <span className="label text-studio-subtle shrink-0">no game needed</span>
        </>
      )}
    </div>
  );
};

interface Props {
  pick: Pick;
  onPick: (p: Pick) => void;
  /** The exe picked last time (a pid is not stable across runs): chosen again once it is seen running. */
  remembered: string | null;
  disabled: boolean;
}

/**
 * The curated picker (plan section 11, user request 2026-09-16): the built-in bench first,
 * then the benchmarks and games the tables recognise, then everything else behind "Show
 * all". A listbox popover, walked with the arrow keys, refreshed every three seconds while
 * open (each refresh is one PowerShell call in main, so never on a timer while closed).
 */
export const ProcessPicker: React.FC<Props> = ({ pick, onPick, remembered, disabled }) => {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [processes, setProcesses] = useState<ProcessPick[]>([]);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const resolved = useRef(false);

  const refresh = useCallback(() => {
    if (!api) return;
    api.capture
      .processes()
      .then(setProcesses)
      .catch(() => setProcesses([]));
  }, []);

  // One fetch on mount finds the remembered exe if it is running; the timer runs only while the list shows.
  useEffect(refresh, [refresh]);
  useEffect(() => {
    if (!open) return;
    refresh();
    const t = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(t);
  }, [open, refresh]);

  useEffect(() => {
    if (resolved.current || !remembered) return;
    const p = processes.find((x) => x.exe.toLowerCase() === remembered.toLowerCase());
    if (!p) return;
    resolved.current = true;
    onPick({ kind: 'process', pid: p.pid, exe: p.exe, title: p.title });
  }, [processes, remembered, onPick]);

  const visible = useMemo(() => rows(processes, showAll), [processes, showAll]);
  const detected = processes.filter((p) => p.group === 'detected');
  const others = processes.filter((p) => p.group === 'other');

  // Opening puts the cursor on the current pick; a refresh keeps it in range.
  useEffect(() => {
    if (!open) return;
    const i = visible.findIndex((r) => samePick(r.pick, pick));
    setActive(i >= 0 ? i : 0);
    list.current?.focus();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, visible.length - 1)));
  }, [visible.length]);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', away);
    return () => window.removeEventListener('pointerdown', away);
  }, [open]);

  const choose = (p: Pick) => {
    resolved.current = true;
    onPick(p);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const last = visible.length - 1;
    switch (e.key) {
      case 'ArrowDown':
        setActive((a) => Math.min(last, a + 1));
        break;
      case 'ArrowUp':
        setActive((a) => Math.max(0, a - 1));
        break;
      case 'Home':
        setActive(0);
        break;
      case 'End':
        setActive(last);
        break;
      case 'Enter':
      case ' ':
        if (visible[active]) choose(visible[active].pick);
        break;
      case 'Escape':
      case 'Tab':
        setOpen(false);
        return;
      default:
        return;
    }
    e.preventDefault();
  };

  useEffect(() => {
    document.getElementById(`pick-${visible[active]?.id}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, visible]);

  const render = (r: Row) => {
    const i = visible.indexOf(r);
    return <Option key={r.id} row={r} active={i === active} selected={samePick(r.pick, pick)} onPick={() => choose(r.pick)} onHover={() => setActive(i)} />;
  };

  return (
    <span ref={box} className="relative inline-flex min-w-0">
      <button
        className="btn max-w-[26rem] border border-studio-border-light bg-studio-bg text-studio-text"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="What to capture: the built-in bench, a benchmark or a game"
      >
        <span className="truncate">{pickLabel(pick)}</span>
        <ChevronDown size={12} className="shrink-0" />
      </button>
      {open && (
        <div
          ref={list}
          role="listbox"
          tabIndex={-1}
          aria-label="What to capture"
          aria-activedescendant={visible[active] ? `pick-${visible[active].id}` : undefined}
          className="absolute right-0 top-8 z-20 w-[30rem] max-h-[24rem] overflow-y-auto rounded-md border border-studio-border-light bg-studio-panel p-1 outline-none"
          onKeyDown={onKeyDown}
        >
          <Group title="Built-in bench">{render(visible[0])}</Group>
          <Group title="Benchmarks and games detected">
            {detected.length === 0 ? (
              <div className="px-2 py-1.5 text-mini text-studio-subtle">Start a game or a benchmark and it appears here.</div>
            ) : (
              visible.filter((r) => r.process?.group === 'detected').map(render)
            )}
          </Group>
          <div role="group" aria-label="Other windowed processes">
            <button className="btn w-full justify-start px-2 h-7" onClick={() => setShowAll((s) => !s)} aria-expanded={showAll}>
              {showAll ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <span className="label">{showAll ? 'Other windowed processes' : `Show all · ${others.length} other window${others.length === 1 ? '' : 's'}`}</span>
            </button>
            {showAll && (others.length === 0 ? <div className="px-2 py-1.5 text-mini text-studio-subtle">No other windows.</div> : visible.filter((r) => r.process?.group === 'other').map(render))}
          </div>
        </div>
      )}
    </span>
  );
};
