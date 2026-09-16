import React from 'react';
import { FileDown, FolderOpen, Trash2 } from 'lucide-react';
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
  onOpen: (id: string) => void;
  onExport: (id: string) => void;
  onReveal: (id: string) => void;
  onDelete: (id: string) => void;
}

const COLUMNS = 'grid grid-cols-[10rem_minmax(8rem,1fr)_5.5rem_6rem_minmax(10rem,2fr)_auto] items-center gap-x-3';

/** The list's verdict is "title · summary" since the headline carried a title; a line written by an earlier build has no separator and is re-derived on open. */
const currentVerdict = (v: string | null) => (v && v.includes(' · ') ? v : null);

/** Saved captures, newest first (plan 17): date, exe, duration, frames, the headline once analysed, and the row's actions. The row opens the session; its buttons act without opening it. */
export const SessionList: React.FC<Props> = ({ sessions, busyId, onOpen, onExport, onReveal, onDelete }) => (
  <section className="rounded-md border border-studio-border bg-studio-panel min-w-0">
    <header className="flex items-center justify-between px-3 h-8 border-b border-studio-border">
      <h2 className="label">Sessions</h2>
      <span className="label text-studio-subtle">{sessions.length === 0 ? 'none yet' : `${sessions.length}`}</span>
    </header>
    {sessions.length === 0 ? (
      <p className="px-3 py-4 text-mini text-studio-muted">
        No captures yet. Pick a process and press Start, or arm Game Mode and launch a game. A session is one folder under %LOCALAPPDATA%\Strata Tune\sessions.
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
            <li key={s.id} className={`${COLUMNS} px-3 h-9 hover:bg-studio-panel-hi min-w-0 cursor-pointer`} onClick={() => onOpen(s.id)} title={`Open ${s.id}`}>
              <button className="figure text-[12px] text-studio-text text-left truncate hover:text-studio-accent" onClick={() => onOpen(s.id)}>
                {fmtDate(s.startedAt)}
              </button>
              <span className="text-mini text-studio-text truncate" title={`${s.exe} · ${s.trigger}`}>
                {s.exe}
                {s.trigger !== 'manual' && <span className="label ml-1.5 text-studio-subtle">{s.trigger.replace(/^process:.*/, 'auto')}</span>}
              </span>
              <span className="figure text-[12px] text-studio-muted">{fmtDuration(s.durationS)}</span>
              <span className="figure text-[12px] text-studio-muted text-right">{s.frames.toLocaleString()}</span>
              <span className="text-mini text-studio-muted truncate" title={verdict ?? undefined}>
                {verdict ?? <span className="text-studio-subtle">not analysed yet · open to analyse</span>}
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
