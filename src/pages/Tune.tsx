import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, inElectron } from '../api';
import { useCollectorStatus } from '../components/useCollectorStatus';
import { CollectorStatusPill } from '../components/CollectorStatusPill';
import { useSettings } from '../components/useSettings';
import { gpuTitle } from '../components/monitor/vendors';
import { gpuLayout } from '../components/monitor/gpuLayout';
import { useTune } from '../components/tune/useTune';
import { useLiveTicks } from '../components/tune/useLiveTicks';
import { StateStrip } from '../components/tune/StateStrip';
import { Controls, gates } from '../components/tune/Controls';
import { Ladder } from '../components/tune/Ladder';
import { LiveMonitor } from '../components/tune/LiveMonitor';
import { Results } from '../components/tune/Results';
import { FlightRecorder } from '../components/tune/FlightRecorder';
import { takeEnableRetry } from '../components/tune/enableRetry';

const Notice: React.FC<{ tone?: 'muted' | 'bad'; children: React.ReactNode }> = ({ tone = 'muted', children }) => (
  <div className={`rounded-md border px-3 py-2 text-mini ${tone === 'bad' ? 'border-rose-500/40 bg-rose-500/10 text-rose-200' : 'border-studio-border bg-studio-panel/50 text-studio-muted'}`}>{children}</div>
);

/**
 * OC auto-tune (plan 16, 17): state strip, controls, the ladder, the live monitor and
 * the results, top to bottom. The collector owns every decision; this page shows its
 * state and asks. Without a collector everything is disabled with the one reason.
 * Plain DOM at 2 Hz, no canvas, nothing animating on its own (17c); both feeds are
 * released on unmount.
 */
export const Tune: React.FC = () => {
  const collector = useCollectorStatus();
  const connected = collector.status === 'connected';
  const settings = useSettings();
  const tune = useTune(connected);
  const live = useLiveTicks(connected);
  const g = gates(inElectron, collector, tune.status, tune.run);
  const gpu = live.tick?.gpu[0] ?? live.snapshot?.gpus[0];
  const gpuName = gpu?.name;
  const memJunctionId = useMemo(() => (live.index ? gpuLayout(live.index, gpuName).memJunction : undefined), [live.index, gpuName]);

  // The logon task is the crash net (plan 16); if Settings could not reach the collector when the
  // flag was set, this is the one retry. Never a loop on the file flag alone: a disable made from
  // Settings or from another instance sharing the collector must stand.
  const fileFlag = tune.status?.enabled;
  useEffect(() => {
    if (!api || !connected || !settings.enableTune || fileFlag !== false || !takeEnableRetry()) return;
    api.tune.enable(true, settings.tuneAcceptedWarningAt ?? undefined).then(tune.refresh, () => undefined);
  }, [connected, settings.enableTune, settings.tuneAcceptedWarningAt, fileFlag, tune.refresh]);

  // The collector went away with a candidate on the card (a run was going, or the file said
  // PENDING): every restore path lives in that process, so the page says so until it is back
  // and asks the main process to relaunch it once.
  const applied = tune.run?.state === 'running' || tune.status?.state === 'PENDING';
  const wasApplied = useRef(false);
  const [lostWhileApplied, setLostWhileApplied] = useState(false);
  useEffect(() => {
    if (connected) {
      wasApplied.current = applied;
      if (tune.status && tune.status.state !== 'PENDING' && tune.run?.state !== 'running') setLostWhileApplied(false);
      return;
    }
    if (wasApplied.current && !lostWhileApplied) {
      setLostWhileApplied(true);
      api?.collector.start().catch(() => undefined);
    }
  }, [connected, applied, lostWhileApplied, tune.status, tune.run]);

  return (
    <div className="p-3 flex-1 flex flex-col gap-3 min-w-0">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 min-w-0">
        <span className="label text-studio-text">Tune</span>
        {gpu && <span className="figure text-[12px] text-studio-text truncate">{gpuTitle(gpu)}</span>}
        <span className="text-micro text-studio-subtle">core and memory offset hunts (the undervolt hunt is not in this version; an offset has no gain on a card at its power limit); found values go on the card only when you keep them, and only until the next reboot</span>
        <span className="flex-1" />
        <CollectorStatusPill state={collector} />
      </header>

      {tune.status?.reverted && <FlightRecorder reverted={tune.status.reverted} flight={tune.flight} memJunctionId={memJunctionId} />}

      <StateStrip status={tune.status} reason={g.find} refusal={tune.refusal} />

      <Controls gates={g} busy={tune.busy} refusal={tune.refusal} onFind={(kind) => void tune.start(kind, settings.enableTune)} onValidate={() => void tune.validate()} onStop={() => void tune.stop()} />

      {lostWhileApplied && (
        <Notice tone="bad">
          The collector stopped while a candidate was applied. The offsets may still be on the card: the collector is being relaunched (accept the permission prompt), and it puts the
          baseline back as it starts. Until then, avoid heavy GPU work.
        </Notice>
      )}
      {tune.status?.problem && <Notice tone="bad">Tune is refusing to act: {tune.status.problem}</Notice>}
      {tune.error && <Notice tone="bad">{tune.error}</Notice>}
      {live.error && <Notice tone="bad">{live.error}</Notice>}

      <section className="rounded-md border border-studio-border bg-studio-panel px-3 py-2 min-w-0">
        <Ladder run={tune.run} />
      </section>

      {!connected ? (
        <Notice>{g.find}: the live monitor, the controls and the results need the elevated collector.</Notice>
      ) : !live.tick || !live.index ? (
        <Notice>Waiting for the first sample…</Notice>
      ) : (
        // Panels fill their cell on the Monitor grid; here each sits in its own block at its natural height.
        <div className="min-w-0">
          <LiveMonitor index={live.index} tick={live.tick} ring={live.ring} snapshot={live.snapshot} status={tune.status} run={tune.run} />
        </div>
      )}

      {tune.status && (
        <div className="min-w-0">
          <Results status={tune.status} export={tune.export} gates={g} busy={tune.busy} onKeep={() => void tune.keep()} onRevert={() => void tune.revert()} />
        </div>
      )}
    </div>
  );
};
