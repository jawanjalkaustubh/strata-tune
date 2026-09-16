import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, FileDown, FolderOpen } from 'lucide-react';
import { api, ipcErrorMessage, type SessionListItem } from '../api';
import type { Report } from '../report/report-types';
import { ReportView } from '../report/ReportView';
import { CaptureBar } from '../components/capture/CaptureBar';
import { LiveFrames } from '../components/capture/LiveFrames';
import { SessionList } from '../components/capture/SessionList';
import { useCaptureState, useLiveFrames } from '../components/capture/useCapture';
import { analyse } from '../components/capture/toReport';
import { useCollectorStatus } from '../components/useCollectorStatus';
import { cachedSensorMeta } from '../components/monitor/cache';

interface Analysed {
  report: Report;
  notes: string[];
}

const Notice: React.FC<{ tone?: 'muted' | 'bad'; children: React.ReactNode }> = ({ tone = 'muted', children }) => (
  <div className={`rounded-md border px-3 py-2 text-mini ${tone === 'bad' ? 'border-rose-500/40 bg-rose-500/10 text-rose-200' : 'border-studio-border bg-studio-panel/50 text-studio-muted'}`}>{children}</div>
);

/**
 * Capture (plan 17): the capture controls and the live frame line on top, the
 * session list beneath; opening a session runs the analysis here in the renderer
 * and shows the report with the same renderer the exported HTML uses (plan 19).
 */
export const Capture: React.FC = () => {
  const state = useCaptureState();
  const capturing = state.status === 'capturing';
  const live = useLiveFrames(capturing);
  const collector = useCollectorStatus();
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [working, setWorking] = useState('');
  const [error, setError] = useState('');
  const [version, setVersion] = useState('');
  /** Analyses done this visit, so going back and forth costs nothing. */
  const analysed = useRef(new Map<string, Analysed>());

  const refresh = useCallback(() => {
    if (!api) return;
    api.sessions.list().then(setSessions).catch((e) => setError(ipcErrorMessage(e)));
  }, []);

  useEffect(() => {
    refresh();
    api?.version().then(setVersion).catch(() => undefined);
  }, [refresh]);

  // A finished capture joins the list on its own.
  useEffect(() => {
    if (state.status === 'done') refresh();
  }, [state.status, state.lastSessionId, refresh]);

  /** Loads and analyses once per session; the headline is written back so the list shows it next time. */
  const ensureAnalysed = useCallback(
    async (id: string): Promise<Analysed> => {
      const hit = analysed.current.get(id);
      if (hit) return hit;
      if (!api) throw new Error('Not running inside Electron');
      setWorking(`Loading ${id}…`);
      const session = await api.sessions.load(id);
      const meta = collector.status === 'connected' ? await cachedSensorMeta().catch(() => undefined) : undefined;
      setWorking(`Analysing ${session.frames.length.toLocaleString()} frames…`);
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

  const openSession = (id: string) =>
    run(id, async () => {
      await ensureAnalysed(id);
      setOpen(id);
    });

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

  const reveal = (id: string) => api?.sessions.reveal(id).catch((e) => setError(ipcErrorMessage(e)));

  const current = open ? analysed.current.get(open) : undefined;

  return (
    <div className="p-3 space-y-3 min-w-0">
      <CaptureBar state={state} />
      {capturing && <LiveFrames frames={live} startedAt={state.startedAt} />}
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
        <SessionList sessions={sessions} busyId={busyId} onOpen={openSession} onExport={exportSession} onReveal={reveal} onDelete={deleteSession} />
      )}
    </div>
  );
};
