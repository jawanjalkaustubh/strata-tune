import React, { useEffect, useRef, useState } from 'react';
import { FileDown, FolderOpen, Settings2, Trash2, X } from 'lucide-react';
import type { SessionListItem } from '../../api';

const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

const fmtDuration = (s: number) => {
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : m > 0 ? `${m} min ${s % 60} s` : `${s} s`;
};

interface Props {
  sessions: SessionListItem[];
  /** The one whose export or delete is in flight; its buttons are held. */
  busyId: string | null;
  /** The one the background pass is analysing right now, if any. */
  analysingId: string | null;
  /** Sessions waiting in .trash; the menu's Empty trash is offered while there are any. */
  trashCount: number;
  onOpen: (id: string) => void;
  onExport: (id: string) => void;
  onReveal: (id: string) => void;
  onDelete: (id: string) => void;
  onEmptyTrash: () => void;
}

/** The page menu: emptying the trash is the one thing here that cannot be undone, so it sits behind a menu and a confirm (in main). */
const PageMenu: React.FC<{ trashCount: number; onEmptyTrash: () => void; onClose: () => void }> = ({ trashCount, onEmptyTrash, onClose }) => {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (!box.current?.contains(t) && !t.closest('[data-menu-anchor]')) onClose();
    };
    window.addEventListener('pointerdown', away);
    return () => window.removeEventListener('pointerdown', away);
  }, [onClose]);
  return (
    <div ref={box} className="absolute right-0 top-8 z-20 w-72 rounded-md border border-studio-border-light bg-studio-panel p-3 space-y-2" role="dialog" aria-label="Sessions menu">
      <div className="flex items-center justify-between">
        <span className="label text-studio-text">Sessions</span>
        <button className="btn-icon w-6 h-6" onClick={onClose} aria-label="Close">
          <X size={12} />
        </button>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-micro text-studio-subtle">Deleted sessions wait in the trash folder until it is emptied.</span>
        <button
          className="btn shrink-0 hover:text-rose-300"
          disabled={trashCount === 0}
          onClick={() => {
            onClose();
            onEmptyTrash();
          }}
        >
          <Trash2 size={12} /> Empty trash{trashCount > 0 ? ` (${trashCount})` : ''}
        </button>
      </div>
    </div>
  );
};

/** Game Mode's 'process:<name>' reads as auto; the bench and the rest say their own word. */
const triggerLabel = (t: string) => (t.startsWith('process:') ? 'auto' : t);

const COLUMNS = 'grid grid-cols-[10rem_minmax(8rem,1fr)_5.5rem_6rem_minmax(10rem,2fr)_auto] items-center gap-x-3';

/** The list's verdict is "title · summary" since the headline carried a title; a line written by an earlier build has no separator and is re-derived on open. */
export const currentVerdict = (v: string | null): string | null => (v && v.includes(' · ') ? v : null);

/** The row shows the headline's title; the sentence is the hover, so nothing is ever clipped (plan section 17a). */
const verdictTitle = (v: string) => v.slice(0, v.indexOf(' · '));

/** Saved captures, newest first (plan 17): date, exe, duration, frames, the headline once analysed, and the row's actions. The row opens the session; its buttons act without opening it. */
export const SessionList: React.FC<Props> = ({ sessions, busyId, analysingId, trashCount, onOpen, onExport, onReveal, onDelete, onEmptyTrash }) => {
  const [menu, setMenu] = useState(false);
  return (
    <section className="rounded-md border border-studio-border bg-studio-panel min-w-0">
      <header className="relative flex items-center gap-2 px-3 h-8 border-b border-studio-border">
        <h2 className="label">Sessions</h2>
        <span className="flex-1" />
        <span className="label text-studio-subtle">{sessions.length === 0 ? 'none yet' : `${sessions.length}`}</span>
        <button className="btn-icon w-6 h-6" data-menu-anchor onClick={() => setMenu((m) => !m)} title="Sessions menu: empty the trash" aria-label="Sessions menu" aria-expanded={menu}>
          <Settings2 size={13} />
        </button>
        {menu && <PageMenu trashCount={trashCount} onEmptyTrash={onEmptyTrash} onClose={() => setMenu(false)} />}
      </header>
      {sessions.length === 0 ? (
        <p className="px-3 py-4 text-mini text-studio-muted">
          No captures yet. Press Start to run the built-in stutter bench, pick a game or a benchmark, or arm Game Mode and launch a game. A session is one folder under %LOCALAPPDATA%\Strata Tune\sessions.
        </p>
      ) : (
        <ul className="divide-y divide-studio-border">
          <li className={`${COLUMNS} px-3 h-7`}>
            <span className="label">Date</span>
            <span className="label">Game</span>
            <span className="label">Length</span>
            <span className="label text-right">Frames</span>
            <span className="label">Verdict</span>
            <span />
          </li>
          {sessions.map((s) => {
            const held = busyId === s.id;
            const verdict = currentVerdict(s.verdict);
            return (
              <li key={s.id} className={`${COLUMNS} px-3 min-h-9 py-1 hover:bg-studio-panel-hi min-w-0 cursor-pointer`} onClick={() => onOpen(s.id)} title={`Open ${s.id}`}>
                <button className="figure text-[12px] text-studio-text text-left hover:text-studio-accent" onClick={() => onOpen(s.id)}>
                  {fmtDate(s.startedAt)}
                </button>
                <span className="text-mini text-studio-text break-words min-w-0" title={`${s.exe} · ${s.trigger}`}>
                  {s.trigger === 'bench' ? 'Stutter bench' : s.exe}
                  {s.trigger !== 'manual' && <span className="label ml-1.5 text-studio-subtle">{triggerLabel(s.trigger)}</span>}
                </span>
                <span className="figure text-[12px] text-studio-muted">{fmtDuration(s.durationS)}</span>
                <span className="figure text-[12px] text-studio-muted text-right">{s.frames.toLocaleString()}</span>
                <span className="text-mini text-studio-muted min-w-0" title={verdict ?? undefined}>
                  {verdict ? verdictTitle(verdict) : <span className="text-studio-subtle">{analysingId === s.id ? 'analysing…' : 'not analysed yet'}</span>}
                </span>
                <span className="inline-flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
                  <button className="btn-icon" onClick={() => onExport(s.id)} disabled={held} title="Export the report as one HTML file" aria-label="Export HTML">
                    <FileDown size={13} />
                  </button>
                  <button className="btn-icon" onClick={() => onReveal(s.id)} disabled={held} title="Show the session folder" aria-label="Show the session folder">
                    <FolderOpen size={13} />
                  </button>
                  <button className="btn-icon hover:text-rose-300" onClick={() => onDelete(s.id)} disabled={held} title="Move this session to the trash folder" aria-label="Delete">
                    <Trash2 size={13} />
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};
