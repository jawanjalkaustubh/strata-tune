import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, inElectron, ipcErrorMessage } from '../../api';
import type { GpuFacts, HeldClocks, Tick } from '../../collector-types';
import { capsForStart, deviceClass as classify, estimateMinutes, vendorForStart, type DeviceClass } from '../../analysis/tune';
import { useCollectorStatus } from '../useCollectorStatus';
import { useSettings } from '../useSettings';
import { gpuTitle } from '../monitor/vendors';
import { gpuLayout } from '../monitor/gpuLayout';
import { boardRails } from '../monitor/rails';
import type { SensorIndex } from '../monitor/sensors';
import { loadedClocks, raise } from '../advisor/thisCard';
import { loadHeldClocks } from '../advisor/heldClocks';
import { headroomSheet } from '../../report/sheet';
import { useTune } from './useTune';
import { useLiveTicks } from './useLiveTicks';
import { StateStrip } from './StateStrip';
import { Controls, gates } from './Controls';
import { ScoreClimb } from './ScoreClimb';
import { LiveMonitor } from './LiveMonitor';
import { Results } from './Results';
import { FlightRecorder } from './FlightRecorder';
import { VendorForm } from './VendorForm';
import { takeEnableRetry } from './enableRetry';
import { openSettings } from '../navigate';
import { HEADROOM_NEEDS_NVIDIA, HEADROOM_OFF, HEADROOM_TAGLINE, WRITES_SENTENCE } from './text';

const Notice: React.FC<{ tone?: 'muted' | 'bad' | 'ok'; children: React.ReactNode }> = ({ tone = 'muted', children }) => (
  <div className={`rounded-md border px-3 py-2 text-mini whitespace-normal break-words ${tone === 'bad' ? 'border-rose-500/40 bg-rose-500/10 text-rose-200' : tone === 'ok' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200' : 'border-studio-border bg-studio-panel/50 text-studio-muted'}`}>{children}</div>
);

/** Plan section 16, 'undervolt first' (phase 8 follow-up item 3): a card whose power limit is already at its maximum sits on the cap under every heavy load; said once before the hunt is offered. */
export function powerCapSentence(gpu: GpuFacts | undefined): string | null {
  if (!gpu || !gpu.powerLimitMw || !gpu.powerMaxLimitMw || gpu.powerLimitMw < gpu.powerMaxLimitMw) return null;
  return `This card's power limit is already at its maximum (${Math.round(gpu.powerLimitMw / 1000)} W), so every heavy load sits on the cap: that is the normal state here, not a fault. A core offset under the cap shifts the V/F curve (same watts, higher clock), a memory offset barely touches power, and each rung is judged by its hash, its top-of-curve clock and its throughput, never by the cap bit.`;
}

/**
 * A machine without the pstate interface (no NVIDIA card, an AMD card) gets the header and the
 * reason and nothing else: no state strip, no form, no live monitor for a hunt that can never
 * run (plan 17d: nothing offered that the machine cannot do).
 */
export const HeadroomUnavailable: React.FC<{ reason: string; problem: string | null }> = ({ reason, problem }) => (
  <section id="headroom" className="space-y-3 min-w-0">
    <header className="space-y-1 px-1 min-w-0">
      <h2 className="text-base font-semibold text-studio-text">{HEADROOM_NEEDS_NVIDIA}</h2>
    </header>
    <Notice>Headroom is unavailable on this machine: {reason}.</Notice>
    {problem && <Notice tone="bad">Tune is refusing to act: {problem}</Notice>}
  </section>
);

/** The DIMM rail as the board's super-IO reads it (the Board panel's own matcher), for the comparison sheet's RAM line; null when no rail matches. */
export function dimmVoltageOf(index: SensorIndex | null, tick: Tick | null, cpuName: string | undefined): number | null {
  if (!index || !tick) return null;
  const rail = boardRails(index, index.hardware(/^(SuperIO|EmbeddedController)$/i), cpuName).find((r) => r.label === 'DIMM');
  const v = rail ? tick.sensors[rail.id] : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** The held clocks the vendor cross-check compares with: the result's as-found figure, else the stored record raised by the live tick under load. */
function heldFor(gpu: GpuFacts | undefined, asFound: HeldClocks | null | undefined): HeldClocks | null {
  if (asFound) return asFound;
  if (!gpu) return null;
  return raise(loadHeldClocks(gpu.name, gpu.driver), loadedClocks(gpu));
}

/**
 * The Headroom section of the Tune page (plan sections 16, 17): behind the settings switch
 * and the warning. Off, it is one line. On: the header with the product sentence and the
 * time estimate, the vendor form, the state strip, the controls, the score climb, the live
 * monitor and the result, top to bottom. The collector owns every decision; this shows its
 * state and asks. Plain DOM at 2 Hz, nothing animating on its own (17c); both feeds are
 * released on unmount.
 */
export const Headroom: React.FC = () => {
  const settings = useSettings();
  const collector = useCollectorStatus();
  const connected = collector.status === 'connected';
  const enabled = settings.enableTune;
  const tune = useTune(connected && enabled);
  const live = useLiveTicks(connected && enabled);
  const g = gates(inElectron, collector, tune.status, tune.run);
  const gpu = live.tick?.gpu[0] ?? live.snapshot?.gpus[0];
  const gpuName = gpu?.name;
  const memJunctionId = useMemo(() => (live.index ? gpuLayout(live.index, gpuName).memJunction : undefined), [live.index, gpuName]);
  const deviceClass: DeviceClass | null = live.snapshot ? classify(live.snapshot) : null;
  const [version, setVersion] = useState('');
  const [saved, setSaved] = useState('');
  useEffect(() => {
    api?.version().then(setVersion).catch(() => undefined);
  }, []);

  // If Settings could not reach the collector when the flag was set, this is the one retry. Never a loop on the
  // file flag alone: a disable made from Settings or from another instance sharing the collector must stand.
  const fileFlag = tune.status?.enabled;
  useEffect(() => {
    if (!api || !connected || !enabled || fileFlag !== false || !takeEnableRetry()) return;
    api.tune.enable(true, settings.tuneAcceptedWarningAt ?? undefined).then(tune.refresh, () => undefined);
  }, [connected, enabled, settings.tuneAcceptedWarningAt, fileFlag, tune.refresh]);

  // The collector went away with a rung on the card (a run was going, or the file said PENDING): every
  // restore path lives in that process, so the section says so until it is back and asks main to relaunch it once.
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

  if (!enabled) {
    return (
      <section id="headroom" className="rounded-md border border-studio-border bg-studio-panel/50 px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <p className="text-mini text-studio-muted">{HEADROOM_OFF}</p>
        <button className="btn btn-accent" onClick={openSettings} title="Opens Settings; the switch sits behind a short note of what the hunt does">
          Turn it on
        </button>
      </section>
    );
  }

  const running = tune.run?.state === 'running';
  const status = tune.status;
  const result = status?.result ?? null;
  // While a hunt runs, the climb shows that hunt alone: the last result's rungs and official run belong to the card before it.
  const asFound = running ? (tune.run?.asFound ?? null) : (tune.run?.asFound ?? result?.asFound ?? null);
  const official = running ? null : (result?.official ?? null);
  // "Free VRAM" beside the Ollama refusal: evict the resident models (keep_alive 0, the family's Free GPU rule) and ask the collector again.
  const [freeing, setFreeing] = useState(false);
  const freeVram = () => {
    if (!api || freeing) return;
    setFreeing(true);
    api.advisor
      .ollamaUnload()
      .then(() => new Promise((r) => setTimeout(r, 1500)))
      .then(tune.refresh, () => undefined)
      .finally(() => setFreeing(false));
  };
  const vendor = vendorForStart(settings);
  const caps = capsForStart(settings);
  const estimate = status ? estimateMinutes('hunt', null, !!vendor) : null;
  const held = heldFor(gpu, result?.baselineHeld);
  const ceilingMem = gpu?.clockOffsets?.maxClockMemMhz ?? null;
  const unavailable = status && !status.nvapi.available ? status.nvapi.reason ?? 'this card has no NVAPI pstate interface' : null;
  const cap = powerCapSentence(gpu);

  const save = async () => {
    if (!api || !status?.result || !tune.export) return;
    setSaved('');
    try {
      const sheet = headroomSheet(tune.export, status.result, { snapshot: live.snapshot, gpu, version, deviceClass, psu: { watts: settings.psuWatts, rating: settings.psuRating }, dimmVoltage: dimmVoltageOf(live.index, live.tick, live.snapshot?.cpu.name) });
      const path = await api.sessions.exportSheet(sheet);
      setSaved(path ? `Saved ${path}` : '');
    } catch (e) {
      setSaved(`Could not save the sheet: ${ipcErrorMessage(e)}`);
    }
  };

  if (unavailable) return <HeadroomUnavailable reason={unavailable} problem={status?.problem ?? null} />;

  return (
    <section id="headroom" className="space-y-3 min-w-0">
      <header className="space-y-1 px-1 min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-base font-semibold text-studio-text">{HEADROOM_TAGLINE}</h2>
          {gpu && <span className="figure text-[12px] text-studio-muted">{gpuTitle(gpu)}</span>}
          {estimate !== null && <span className="text-micro text-studio-subtle">a full hunt takes about {estimate} minutes</span>}
        </div>
        <p className="text-micro text-studio-subtle whitespace-normal break-words">{WRITES_SENTENCE}</p>
      </header>

      {cap && <Notice>{cap}</Notice>}
      {status?.reverted && <FlightRecorder reverted={status.reverted} flight={tune.flight} memJunctionId={memJunctionId} />}
      <StateStrip status={status} reason={g.find} refusal={tune.refusal} />
      <VendorForm lastRun={result?.vendor ?? null} deltas={status?.nvapi.deltas ?? null} held={held} ceilingMemMhz={ceilingMem} disabled={running} laptop={!!live.snapshot?.chassis.isLaptop} onRelease={() => void tune.release()} />
      <Controls gates={g} busy={tune.busy} refusal={tune.refusal} estimateMinutes={estimate} onFind={(kind) => void tune.start(kind, enabled, vendor, caps)} onStop={() => void tune.stop()} onFreeVram={freeVram} />

      {lostWhileApplied && (
        <Notice tone="bad">
          The collector stopped while a rung was applied. The offsets may still be on the card: the collector is being relaunched (accept the permission prompt), and it puts the baseline back as it
          starts. Until then, avoid heavy GPU work.
        </Notice>
      )}
      {status?.problem && <Notice tone="bad">Tune is refusing to act: {status.problem}</Notice>}
      {tune.run && tune.run.state === 'failed' && tune.run.error && <Notice tone="bad">{tune.run.error}</Notice>}
      {tune.error && <Notice tone="bad">{tune.error}</Notice>}
      {live.error && <Notice tone="bad">{live.error}</Notice>}
      {saved && <Notice tone={saved.startsWith('Saved') ? 'ok' : 'bad'}>{saved}</Notice>}

      <section className="rounded-md border border-studio-border bg-studio-panel px-3 py-2 min-w-0">
        <ScoreClimb run={tune.run} rungs={result?.rungs ?? []} asFound={asFound} official={official} baseline={status?.baseline ?? null} />
      </section>

      {!connected ? (
        <Notice>{g.find}: the live monitor, the controls and the result need the elevated collector.</Notice>
      ) : !live.tick || !live.index ? (
        <Notice>Waiting for the first sample…</Notice>
      ) : (
        <div className="min-w-0">
          <LiveMonitor index={live.index} tick={live.tick} ring={live.ring} snapshot={live.snapshot} status={status} run={tune.run} />
        </div>
      )}

      {status && running && result ? (
        // The climb above shows the hunt under way; the last result is one line until the new hunt replaces it, never two hunts on one screen.
        <Notice>
          Last result: {result.official?.score ? `${result.official.score.points.toLocaleString('en-US')} points` : result.asFound?.score ? `${result.asFound.score.points.toLocaleString('en-US')} points as found` : 'no score'} on {new Date(result.foundAt).toLocaleDateString()}; the hunt now running replaces it.
        </Notice>
      ) : (
        status && (
          <div className="min-w-0">
            <Results status={status} export={tune.export} gates={g} busy={tune.busy} deviceClass={deviceClass} gpuName={gpuName} onRevert={() => void tune.revert()} onSave={api ? save : null} />
          </div>
        )
      )}
    </section>
  );
};
