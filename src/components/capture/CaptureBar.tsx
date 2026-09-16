import React, { useCallback, useEffect, useState } from 'react';
import { Crosshair, Play, RefreshCw, Square } from 'lucide-react';
import { api, ipcErrorMessage, type CaptureState, type CaptureStatus, type ProcessInfo } from '../../api';
import { Pill, type Tone } from '../monitor/Pill';

const TONE_OF: Record<CaptureStatus, Tone> = { idle: 'idle', armed: 'info', capturing: 'ok', saving: 'warn', done: 'ok', error: 'bad' };
const LABEL_OF: Record<CaptureStatus, string> = { idle: 'Idle', armed: 'Armed', capturing: 'Capturing', saving: 'Saving…', done: 'Saved', error: 'Error' };

const GAME_MODE_HOTKEY = 'Ctrl+Shift+G';

/** Process picker: every window on the desktop, refreshed on demand (a PowerShell call, so never on a timer). */
const ProcessPicker: React.FC<{ pid: number | null; onPick: (pid: number | null) => void; disabled: boolean }> = ({ pid, onPick, disabled }) => {
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(() => {
    if (!api) return;
    setBusy(true);
    api.capture
      .processes()
      .then(setProcesses)
      .catch(() => setProcesses([]))
      .finally(() => setBusy(false));
  }, []);
  useEffect(refresh, [refresh]);
  return (
    <span className="inline-flex items-center gap-1 min-w-0">
      <select
        className="figure text-[12px] h-7 max-w-[22rem] bg-studio-bg border border-studio-border-light rounded-control px-1.5 text-studio-text outline-none disabled:opacity-40"
        value={pid ?? ''}
        onChange={(e) => onPick(e.target.value ? Number(e.target.value) : null)}
        disabled={disabled}
        aria-label="Process to capture"
      >
        <option value="">Pick a process…</option>
        {processes.map((p) => (
          <option key={p.pid} value={p.pid}>
            {p.exe} · {p.title.length > 40 ? `${p.title.slice(0, 40)}…` : p.title} · {p.pid}
          </option>
        ))}
      </select>
      <button className="btn-icon" onClick={refresh} disabled={busy || disabled} title="Refresh the process list" aria-label="Refresh the process list">
        <RefreshCw size={12} />
      </button>
    </span>
  );
};

/** The capture state pill, the Game Mode arm switch, the process picker and Start/Stop, on one row (plan 17). */
export const CaptureBar: React.FC<{ state: CaptureState }> = ({ state }) => {
  const [pid, setPid] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const installed = state.presentMon.installed;
  const busy = state.status === 'capturing' || state.status === 'saving';

  const call = (p: Promise<unknown>) => {
    setError('');
    setPending(true);
    p.catch((e) => setError(ipcErrorMessage(e))).finally(() => setPending(false));
  };
  const start = () => api && pid !== null && call(api.capture.start(pid));
  const stop = () => api && call(api.capture.stop());
  const arm = () => api && call(api.capture.arm(!state.armed));

  const notice = error || (!installed ? state.presentMon.message : state.message);
  const noticeTone = error || !installed || state.status === 'error' ? 'text-rose-300' : 'text-studio-muted';

  return (
    <section className="rounded-md border border-studio-border bg-studio-panel px-3 py-2 space-y-1.5 min-w-0">
      <div className="flex items-center gap-3 flex-wrap min-w-0">
        <Pill tone={TONE_OF[state.status]} title={state.message}>
          {LABEL_OF[state.status]}
          {state.target && state.status === 'capturing' ? ` · ${state.target.exe}` : ''}
        </Pill>
        <button
          className={`btn ${state.armed ? 'bg-sky-500/15 text-sky-300 hover:text-sky-200' : ''}`}
          onClick={arm}
          disabled={!api || !installed || pending}
          title={`Start a capture on its own when a game appears: the allowlist by name, exclusive fullscreen, or ${GAME_MODE_HOTKEY} on the window in front`}
          aria-pressed={state.armed}
        >
          <Crosshair size={13} /> {state.armed ? 'Game Mode armed' : 'Arm Game Mode'}
        </button>
        <span className="flex-1" />
        <ProcessPicker pid={pid} onPick={setPid} disabled={!api || busy} />
        {busy ? (
          <button className="btn bg-rose-500/15 text-rose-300 hover:text-rose-200" onClick={stop} disabled={pending || state.status === 'saving'}>
            <Square size={12} /> Stop
          </button>
        ) : (
          <button className="btn btn-accent" onClick={start} disabled={!api || !installed || pid === null || pending}>
            <Play size={12} /> Start
          </button>
        )}
      </div>
      {notice && (
        <div className={`text-mini ${noticeTone} truncate`} title={notice}>
          {notice}
        </div>
      )}
    </section>
  );
};
