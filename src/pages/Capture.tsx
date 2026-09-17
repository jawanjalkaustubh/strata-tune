import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, FileDown, FolderOpen } from 'lucide-react';
import { api, ipcErrorMessage, type SessionListItem } from '../api';
import type { Report } from '../report/report-types';
import { ReportView } from '../report/ReportView';
import { CaptureBar } from '../components/capture/CaptureBar';
import { LiveFrames } from '../components/capture/LiveFrames';
import { currentVerdict, SessionList } from '../components/capture/SessionList';
import { useCaptureState, useLiveFrames } from '../components/capture/useCapture';
import { analyse } from '../components/capture/toReport';
import { useCollectorStatus } from '../components/useCollectorStatus';
import { cachedSensorMeta } from '../components/monitor/cache';

interface Analysed {
  report: Report;
  notes: string[];
}

/** The gap between two background analyses, so the page stays responsive while older sessions fill in. */
const BACKGROUND_GAP_MS = 250;

/** The bench report opened on its own for this session id; module-level so a page revisit shows the list, not the report again. */
let autoOpened: string | null = null;

const Notice: React.FC<{ tone?: 'muted' | 'bad'; children: React.ReactNode }> = ({ tone = 'muted', children }) => (
  <div className={`rounded-md border px-3 py-2 text-mini ${tone === 'bad' ? 'border-rose-500/40 bg-rose-500/10 text-rose-200' : 'border-studio-border bg-studio-panel/50 text-studio-muted'}`}>{children}</div>
);

/**
 * Capture (plan 17): the capture controls and the live frame line on top, the
 * session list beneath; opening a session runs the analysis here in the renderer
 * and shows the report with the same renderer the exported HTML uses (plan 19).
 * Sessions not yet analysed are analysed one at a time in the background while
 * the page is open and nothing is being captured, so the list fills in on its own;
 * a finished bench run (plan 11a) opens its report at once.
 */
export const Capture: React.FC = () => {
  const state = useCaptureState();
  const capturing = state.status === 'capturing';
  const live = useLiveFrames(capturing);
  const collector = useCollectorStatus();
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [trashCount, setTrashCount] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [analysingId, setAnalysingId] = useState<string | null>(null);
  const [working, setWorking] = useState('');
  const [error, setError] = useState('');
  const [version, setVersion] = useState('');
  /** Analyses done this visit, so going back and forth costs nothing. */
  const analysed = useRef(new Map<string, Analysed>());
  /** Sessions the background pass could not analyse; tried once, not forever. */
  const failed = useRef(new Set<string>());
  /** The background analysis in flight, so a re-run of the effect (a version or collector change) never starts it twice. */
  const inFlight = useRef<string | null>(null);
  /** Bumped when a background analysis ends, so the pass moves to the next session on its own, a failed one included. */
  const [pass, setPass] = useState(0);

  const refresh = useCallback(() => {
    if (!api) return;
    api.sessions.list().then(setSessions).catch((e) => setError(ipcErrorMessage(e)));
    api.sessions.trashCount().then(setTrashCount).catch(() => undefined);
  }, []);

  useEffect(() => {
    refresh();
    api?.version().then(setVersion).catch(() => undefined);
  }, [refresh]);

  /** Loads and analyses once per session; the headline is written back so the list shows it next time. Quiet runs are the background pass and show no progress line. */
  const ensureAnalysed = useCallback(
    async (id: string, quiet = false): Promise<Analysed> => {
      const hit = analysed.current.get(id);
      if (hit) return hit;
      if (!api) throw new Error('Not running inside Electron');
      if (!quiet) setWorking(`Loading ${id}…`);
      const session = await api.sessions.load(id);
      const meta = collector.status === 'connected' ? await cachedSensorMeta().catch(() => undefined) : undefined;
      if (!quiet) setWorking(`Analysing ${session.frames.length.toLocaleString()} frames…`);
      // Let the line above paint before the analysis holds the thread.
      await new Promise((r) => setTimeout(r, 0));
      const { report, verdict } = analyse(session, version, meta);
      const result: Analysed = { report, notes: session.notes };
      analysed.current.set(id, result);
      await api.sessions.setVerdict(id, verdict).catch(() => undefined);
      refresh();
      return result;
    },
    [collector.status, version, refresh]
  );

  const run = (id: string, job: () => Promise<void>) => {
    setError('');
    setBusyId(id);
    job()
      .catch((e) => setError(ipcErrorMessage(e)))
      .finally(() => {
        setBusyId(null);
        setWorking('');
      });
  };

  const openSession = useCallback(
    (id: string) =>
      run(id, async () => {
        await ensureAnalysed(id);
        setOpen(id);
      }),
    [ensureAnalysed]
  );

  // A finished capture joins the list on its own; a finished bench opens its report.
  useEffect(() => {
    if (state.status !== 'done') return;
    refresh();
    if (state.lastTrigger === 'bench' && state.lastSessionId && autoOpened !== state.lastSessionId) {
      autoOpened = state.lastSessionId;
      openSession(state.lastSessionId);
    }
  }, [state.status, state.lastSessionId, state.lastTrigger, refresh, openSession]);

  // The background pass: one unanalysed session at a time, in idle time, never while a capture runs (plan A6) or an action is in flight.
  const paused = capturing || state.status === 'saving' || busyId !== null;
  useEffect(() => {
    if (paused || inFlight.current) return;
    const next = sessions.find((s) => !currentVerdict(s.verdict) && !analysed.current.has(s.id) && !failed.current.has(s.id));
    if (!next) return;
    let cancelled = false;
    let idle = 0;
    const timer = setTimeout(() => {
      idle = requestIdleCallback(() => {
        if (cancelled) return;
        inFlight.current = next.id;
        setAnalysingId(next.id);
        ensureAnalysed(next.id, true)
          .catch(() => failed.current.add(next.id))
          .finally(() => {
            inFlight.current = null;
            setAnalysingId(null);
            setPass((n) => n + 1);
          });
      });
    }, BACKGROUND_GAP_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      cancelIdleCallback(idle);
    };
  }, [sessions, paused, ensureAnalysed, pass]);

  const exportSession = (id: string) =>
    run(id, async () => {
      const { report } = await ensureAnalysed(id);
      setWorking('Exporting…');
      await api!.sessions.exportHtml(report);
    });

  const deleteSession = (id: string) =>
    run(id, async () => {
      await api!.sessions.delete(id);
      analysed.current.delete(id);
      if (open === id) setOpen(null);
      refresh();
    });

  const emptyTrash = () => {
    if (!api) return;
    setError('');
    api.sessions
      .emptyTrash()
      .then((n) => {
        if (n !== null) setTrashCount(0);
      })
      .catch((e) => setError(ipcErrorMessage(e)));
  };

  const reveal = (id: string) => api?.sessions.reveal(id).catch((e) => setError(ipcErrorMessage(e)));

  const current = open ? analysed.current.get(open) : undefined;

  return (
    <div className="p-3 space-y-3 min-w-0">
      <CaptureBar state={state} />
      {capturing && <LiveFrames frames={live} startedAt={state.startedAt} bench={state.target?.trigger === 'bench'} />}
      {error && <Notice tone="bad">{error}</Notice>}
      {working && <Notice>{working}</Notice>}
      {open && current ? (
        <section className="space-y-2 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <button className="btn" onClick={() => setOpen(null)}>
              <ArrowLeft size={13} /> Sessions
            </button>
            <span className="figure text-[12px] text-studio-muted truncate">{open}</span>
            <span className="flex-1" />
            <button className="btn" onClick={() => exportSession(open)} disabled={busyId === open}>
              <FileDown size={13} /> Export HTML
            </button>
            <button className="btn" onClick={() => reveal(open)}>
              <FolderOpen size={13} /> Folder
            </button>
          </div>
          {current.notes.length > 0 && <Notice>{current.notes.join(' · ')}</Notice>}
          <div className="rounded-md border border-studio-border overflow-hidden">
            <ReportView report={current.report.report} session={current.report.session} brand={false} />
          </div>
        </section>
      ) : (
        <SessionList
          sessions={sessions}
          busyId={busyId}
          analysingId={analysingId}
          trashCount={trashCount}
          onOpen={openSession}
          onExport={exportSession}
          onReveal={reveal}
          onDelete={deleteSession}
          onEmptyTrash={emptyTrash}
        />
      )}
    </div>
  );
};
