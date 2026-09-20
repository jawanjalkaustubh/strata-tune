import React, { useState } from 'react';
import { Crosshair, Play, Square, UserPlus } from 'lucide-react';
import { api, ipcErrorMessage, type CaptureState, type CaptureStatus } from '../../api';
import { Pill, type Tone } from '../monitor/Pill';
import { BENCH_PICK, ProcessPicker, type Pick } from './ProcessPicker';

const TONE_OF: Record<CaptureStatus, Tone> = { idle: 'idle', armed: 'info', capturing: 'ok', saving: 'warn', done: 'ok', error: 'bad' };
const LABEL_OF: Record<CaptureStatus, string> = { idle: 'Idle', armed: 'Armed', capturing: 'Capturing', saving: 'Saving…', done: 'Saved', error: 'Error' };

const GAME_MODE_HOTKEY = 'Ctrl+Shift+G';
const PICK_KEY = 'strata-tune.capture.pick';

type Remembered = { kind: 'bench' } | { kind: 'process'; exe: string };

/** The last choice, by exe rather than pid; the bench is the default because it is always there. */
function readRemembered(): Remembered {
  try {
    const r = JSON.parse(localStorage.getItem(PICK_KEY) || '') as Partial<Remembered>;
    if (r.kind === 'process' && typeof r.exe === 'string') return { kind: 'process', exe: r.exe };
  } catch {
    /* nothing remembered */
  }
  return { kind: 'bench' };
}

function remember(p: Pick) {
  try {
    localStorage.setItem(PICK_KEY, JSON.stringify(p.kind === 'bench' ? { kind: 'bench' } : { kind: 'process', exe: p.exe }));
  } catch {
    /* private mode or full storage */
  }
}

/** The capture state pill, the Game Mode arm switch, the picker and Start/Stop, on one row (plan 17). */
export const CaptureBar: React.FC<{ state: CaptureState }> = ({ state }) => {
  const [remembered] = useState(readRemembered);
  const [pick, setPick] = useState<Pick>(BENCH_PICK);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  /** What adding the account answered (electron/presentmon.ts grantTraceAccess); shown until the next start. */
  const [granted, setGranted] = useState('');
  const installed = state.presentMon.installed;
  // The account is not in Performance Log Users (the first laptop, 2026-09-19): said before Start, with the fix, instead of PresentMon's exit 6 after the bench has begun.
  const traceRefused = state.trace !== null && !state.trace.allowed;
  const busy = state.status === 'capturing' || state.status === 'saving';

  const call = (p: Promise<unknown>) => {
    setError('');
    setPending(true);
    p.catch((e) => setError(ipcErrorMessage(e))).finally(() => setPending(false));
  };
  const start = () => {
    setGranted('');
    if (api) call(pick.kind === 'bench' ? api.capture.startBench() : api.capture.start(pick.pid));
  };
  const stop = () => api && call(api.capture.stop());
  const arm = () => api && call(api.capture.arm(!state.armed));
  const grant = () => api && call(api.capture.grantTrace().then((r) => setGranted(r.message)));
  const choose = (p: Pick) => {
    setPick(p);
    remember(p);
  };

  const notice = error || (!installed ? state.presentMon.message : granted || (traceRefused ? state.trace!.reason : state.message));
  const noticeTone = error || !installed || state.status === 'error' ? 'text-rose-300' : traceRefused && !granted ? 'text-amber-200' : 'text-studio-muted';

  return (
    <section className="rounded-md border border-studio-border bg-studio-panel px-3 py-2 space-y-1.5 min-w-0">
      <div className="flex items-center gap-3 flex-wrap min-w-0">
        <Pill tone={TONE_OF[state.status]} title={state.message}>
          {LABEL_OF[state.status]}
          {state.target && state.status === 'capturing' ? ` · ${state.target.trigger === 'bench' ? 'stutter bench' : state.target.exe}` : ''}
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
        <ProcessPicker pick={pick} onPick={choose} remembered={remembered.kind === 'process' ? remembered.exe : null} disabled={!api || busy} />
        {busy ? (
          <button className="btn bg-rose-500/15 text-rose-300 hover:text-rose-200" onClick={stop} disabled={pending || state.status === 'saving'}>
            <Square size={12} /> Stop
          </button>
        ) : (
          <button className="btn btn-accent" onClick={start} disabled={!api || !installed || pending}>
            <Play size={12} /> Start
          </button>
        )}
      </div>
      {notice && (
        <div className={`text-mini ${noticeTone} break-words min-w-0 flex flex-wrap items-center gap-x-3 gap-y-1`}>
          <span className="min-w-0">{notice}</span>
          {traceRefused && !granted && installed && (
            <button className="btn" onClick={grant} disabled={!api || pending || busy} title="Runs: net localgroup &quot;Performance Log Users&quot; <your account> /add, as administrator (one UAC prompt). Nothing else changes.">
              <UserPlus size={13} /> Add my account
            </button>
          )}
        </div>
      )}
    </section>
  );
};
