import React, { useEffect, useMemo, useState } from 'react';
import { api, ipcErrorMessage, type BenchError, type GpuBench, type OllamaBench, type OllamaList } from '../api';
import { loadSettings, saveSettings, type Settings } from '../settings';
import { useCollectorStatus } from '../components/useCollectorStatus';
import { CollectorStatusPill } from '../components/CollectorStatusPill';
import { Pill } from '../components/monitor/Pill';
import { vendorOf } from '../components/monitor/vendors';
import { HardwarePicker } from '../components/advisor/HardwarePicker';
import { StatsCard } from '../components/advisor/StatsCard';
import { Calibration } from '../components/advisor/Calibration';
import { BestFor } from '../components/advisor/BestFor';
import { ModelList } from '../components/advisor/ModelList';
import { Tag } from '../components/advisor/Tag';
import { gib, tokens } from '../components/advisor/format';
import { factsFromPicker, factsFromSnapshot, freeRamBytes, libraryVram, sameGpu, type HardwareFacts, type PickerChoice } from '../components/advisor/hardware';
import { discreteAdapter } from '../analysis/adapters';
import { ALL_TAGS, DEFAULT_FACTOR, GPU_NAMES, MAX_CONTEXT, adviseRows, bestRows, derivedFactor, gpuSpecOf, npuTopsOf, streamedBandwidth } from '../components/advisor/rows';
import { thisCard } from '../components/advisor/thisCard';
import { useHeldClocks } from '../components/advisor/useHeldClocks';

const DEFAULT_CONTEXT = 8192;
const MEASUREMENTS_KEY = 'strata-tune.calibration';

/** A timing carries the card and driver it was taken on, so a swap or a driver update retires it the way bench.json is retired. */
type Measurement = OllamaBench & { device: string; driver: string | null };

function loadMeasurements(): Record<string, Measurement> {
  try {
    const raw = JSON.parse(localStorage.getItem(MEASUREMENTS_KEY) || '{}') as Record<string, Partial<Measurement>>;
    return Object.fromEntries(Object.entries(raw).filter(([, m]) => typeof m.device === 'string' && typeof m.tokPerSec === 'number')) as Record<string, Measurement>;
  } catch {
    return {};
  }
}

function saveMeasurements(m: Record<string, Measurement>) {
  try {
    localStorage.setItem(MEASUREMENTS_KEY, JSON.stringify(m));
  } catch {
    /* private mode or full storage: the numbers still show this session */
  }
}

/** The dev box's card first so the standalone page opens on something familiar; any table row otherwise. */
const initialPicker = (): PickerChoice => ({ gpuName: GPU_NAMES.find((n) => /5090/.test(n)) ?? GPU_NAMES[0] ?? '', ramGiB: 32, freeDiskGiB: null });

/** Local AI model advisor (master plan section 10): the AI stats card, then every model in models.json against this machine. */
export const Advisor: React.FC = () => {
  const status = useCollectorStatus();
  const connected = status.status === 'connected';

  const [snapshotFacts, setSnapshotFacts] = useState<HardwareFacts | null>(null);
  const [snapshotError, setSnapshotError] = useState('');
  const [picker, setPicker] = useState<PickerChoice>(initialPicker);
  const [ollama, setOllama] = useState<OllamaList | null>(null);
  const [ollamaError, setOllamaError] = useState<BenchError | null>(null);
  const [bench, setBench] = useState<GpuBench | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [benchError, setBenchError] = useState('');
  const [stored, setStored] = useState<Record<string, Measurement>>(loadMeasurements);
  const [calibrating, setCalibrating] = useState<string | null>(null);
  const [calibrateError, setCalibrateError] = useState('');
  /** Stop pressed on a run (plan section 17c): said once, in place of a result, until the next run. */
  const [stopped, setStopped] = useState<'measure' | 'calibrate' | null>(null);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [contextTokens, setContextTokens] = useState(DEFAULT_CONTEXT);
  const [filter, setFilter] = useState<string | null>(null);

  // Ollama needs no collector, only the app; the plain browser has no bridge.
  useEffect(() => {
    if (!api) return;
    let live = true;
    api.advisor.ollamaList().then((r) => live && ('error' in r ? setOllamaError(r) : setOllama(r)));
    return () => {
      live = false;
    };
  }, []);

  const modelsDir = ollama?.modelsDir ?? null;
  useEffect(() => {
    if (!api || !connected) {
      setSnapshotFacts(null);
      return;
    }
    const c = api.collector;
    let live = true;
    (async () => {
      const snapshot = await c.snapshot();
      // Free RAM is a sensor, not a snapshot field; without it the total stands in. So is an AMD or Intel card's VRAM in use.
      let freeRam: number | null = null;
      let vram: { usedMiB: number; totalMiB: number } | null = null;
      try {
        const [meta, latest] = await Promise.all([c.sensorsMeta(), c.sensorsLatest()]);
        freeRam = freeRamBytes(meta, latest);
        const card = discreteAdapter(snapshot);
        if (card && snapshot.gpus.length === 0) vram = libraryVram(meta, latest, card.name);
      } catch {
        /* the stream may not be up yet */
      }
      if (live) setSnapshotFacts(factsFromSnapshot(snapshot, freeRam, modelsDir, vram));
    })().catch((e) => live && setSnapshotError(ipcErrorMessage(e)));
    return () => {
      live = false;
    };
  }, [connected, modelsDir]);

  const facts: HardwareFacts = snapshotFacts ?? factsFromPicker(picker, gpuSpecOf(picker.gpuName)?.vramGiB ?? 0);
  const spec = gpuSpecOf(facts.gpuName, snapshotFacts ? snapshotFacts.vramBytes / 1024 ** 2 : undefined);
  // This card against the reference row (plan section 10): the driver's limits and the clocks it holds when the page loads it.
  const { held, latest, watch } = useHeldClocks(facts);
  const card = facts.gpu ? thisCard(facts.gpu, spec?.tiles.busBits ?? null, held) : null;

  // bench.json is reused until the driver changes, so the cached line is read once the driver is known.
  useEffect(() => {
    if (!api) return;
    let live = true;
    api.advisor.benchGpu({ driver: facts.driver, run: false }).then((r) => live && r && !('error' in r) && setBench(r));
    return () => {
      live = false;
    };
  }, [facts.driver]);

  const benchApplies = !!bench && sameGpu(bench.device, facts.gpuName);
  const bandwidth = streamedBandwidth(bench, benchApplies, card?.bandwidthGBs ?? spec?.bandwidthGBs ?? null);
  const bandwidthGBs = bandwidth?.gbs ?? null;
  const factor = settings.calibrationFactor ?? DEFAULT_FACTOR;
  // Apple Silicon: the CPU and GPU share one pool, so the "RAM bus" a spilled model streams from is the pool's measured bandwidth, not a DIMM table.
  const machine: HardwareFacts = facts.unified && benchApplies && bench ? { ...facts, ramBandwidthGBs: bench.bandwidthGBs, ramBandwidthDefault: false } : facts;

  // Only timings from this card and driver count; the rest stay stored for the card they belong to.
  const measurements = useMemo(
    () => Object.fromEntries(Object.entries(stored).filter(([, m]) => sameGpu(m.device, facts.gpuName) && (m.driver === null || facts.driver === null || m.driver === facts.driver))),
    [stored, facts.gpuName, facts.driver]
  );

  const rows = useMemo(() => adviseRows({ facts: machine, bandwidthGBs, contextTokens, factor }), [machine, bandwidthGBs, contextTokens, factor]);
  const picks = useMemo(() => bestRows(rows), [rows]);
  const shown = filter ? rows.filter((r) => r.tags.includes(filter)) : rows;

  const estimates = useMemo(() => {
    const byTag = new Map(rows.map((r) => [r.pullTag, r]));
    return Object.fromEntries((ollama?.installed ?? []).map((m) => [m.name, byTag.get(m.name) ?? byTag.get(m.name.replace(/:latest$/, ''))]));
  }, [rows, ollama]);
  const measuredByTag = useMemo(() => Object.fromEntries(Object.values(measurements).map((m) => [m.model, m.tokPerSec])), [measurements]);
  const derived = useMemo(() => derivedFactor(measurements, estimates, factor), [measurements, estimates, factor]);

  // Both runs load the card, so both are watched for the clocks it holds; only a run that finished counts.
  const measure = async () => {
    if (!api || measuring) return;
    setMeasuring(true);
    setBenchError('');
    setStopped(null);
    const stop = watch();
    const r = await api.advisor.benchGpu({ driver: facts.driver, run: true });
    const ok = !!r && !('error' in r);
    stop(ok);
    if (r && 'error' in r) {
      if (r.code === 'cancelled') setStopped('measure');
      else setBenchError(r.error);
    } else if (r) setBench(r);
    setMeasuring(false);
  };

  const calibrate = async (model: string) => {
    if (!api || calibrating) return;
    setCalibrating(model);
    setCalibrateError('');
    setStopped(null);
    const stop = watch();
    const r = await api.advisor.benchOllama(model);
    stop(!('error' in r));
    if ('error' in r) {
      if (r.code === 'cancelled') setStopped('calibrate');
      else setCalibrateError(`${model}: ${r.error}`);
    } else {
      const next = { ...stored, [model]: { ...r, device: facts.gpuName, driver: facts.driver } };
      setStored(next);
      saveMeasurements(next);
    }
    setCalibrating(null);
  };

  // Stop (plan section 17c): the worker is killed or the generation aborted; the pending call answers 'cancelled'.
  const stopMeasure = () => void api?.advisor.cancelBenchGpu();
  const stopCalibrate = () => void api?.advisor.cancelBenchOllama();

  // Escape stops whichever run is going, the same as its button.
  useEffect(() => {
    if (!measuring && calibrating === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (measuring) stopMeasure();
      if (calibrating !== null) stopCalibrate();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [measuring, calibrating]);

  // Merged over what storage holds now: the PSU form and the Monitor write their own fields in between.
  const setFactor = (calibrationFactor: number | null) => {
    const next = { ...loadSettings(), calibrationFactor };
    saveSettings(next);
    setSettings(next);
  };

  const summaryKind = facts.source === 'collector' ? 'measured' : 'spec';
  const diskLabel = facts.diskLetter ? `${facts.diskLetter}:` : 'the model drive';

  // Connected but the snapshot (1–3 s of WMI) not in yet: nothing is drawn from the picker's
  // default, which is the dev box's card and would show another PC's numbers for a second
  // (seen on the first laptop, 2026-09-19: "VRAM 32 GiB · RAM 32 GiB" before "RAM 16 GiB").
  if (connected && !snapshotFacts && !snapshotError) {
    return (
      <div className="p-4 max-w-6xl w-full mx-auto space-y-4">
        <header className="flex flex-wrap items-center gap-3">
          <h1 className="text-base font-semibold text-studio-text">AI Models</h1>
          <CollectorStatusPill state={status} />
        </header>
        <p className="text-mini text-studio-muted">Reading this machine…</p>
      </div>
    );
  }

  return (
    <div className="p-4 max-w-6xl w-full mx-auto space-y-4">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-base font-semibold text-studio-text">AI Models</h1>
        <CollectorStatusPill state={status} />
        <span className="flex-1" />
        <span className="flex items-center gap-1.5 text-mini text-studio-muted figure">
          {facts.integrated ? 'no discrete GPU' : facts.unified ? `GPU working set ${gib(facts.vramBytes, 0)} of unified` : `VRAM ${gib(facts.vramBytes, 0)}`} · RAM {gib(facts.ramBytes, 0)}
          {facts.freeDiskBytes !== null && ` · ${diskLabel} ${gib(facts.freeDiskBytes, 0)} free`}
          <Tag kind={summaryKind} title={facts.source === 'collector' ? (facts.unified ? "From the macOS collector: the working set is what Metal lets the GPU hold of the shared memory" : 'From the collector snapshot') : 'From gpus.json and the inputs beside the picker'} />
          <span>· {facts.unified ? 'memory' : 'RAM'} bus {machine.ramBandwidthGBs.toFixed(0)} GB/s</span>
          <Tag kind={machine.ramBandwidthDefault ? 'default' : facts.unified ? 'measured' : 'spec'} title={machine.ramBandwidthDefault ? (facts.unified ? 'Press Measure: unified memory has no DIMM table, the figure is measured' : 'No module speed known: the analysis default') : facts.unified ? 'Measured by the Metal worker: one pool for the CPU and the GPU' : 'From the configured DIMM speed and channel count'} />
        </span>
      </header>

      {facts.source === 'picker' && (
        <div className="rounded-md border border-studio-border bg-studio-panel/50 px-3 py-2.5 flex flex-wrap items-end gap-3">
          <Pill tone="idle" title={status.message}>
            Collector not connected
          </Pill>
          <HardwarePicker gpuNames={GPU_NAMES} choice={picker} onChange={setPicker} />
          {snapshotError && <span className="text-mini text-rose-300">Snapshot failed: {snapshotError}</span>}
        </div>
      )}

      <StatsCard
        gpuName={facts.gpuName}
        gpuColour={vendorOf(facts.gpuName).colour}
        spec={spec}
        card={card}
        integrated={facts.integrated}
        laptop={facts.laptop}
        ramBandwidthGBs={machine.ramBandwidthGBs}
        latest={latest}
        npuTops={npuTopsOf(facts.cpuName)}
        bench={bench}
        applies={benchApplies}
        measuring={measuring}
        canMeasure={!!api}
        error={benchError}
        stopped={stopped === 'measure'}
        onMeasure={measure}
        onStop={stopMeasure}
      />

      <Calibration
        installed={ollama?.installed ?? null}
        loaded={(ollama?.loaded ?? []).map((m) => m.name)}
        available={!!api}
        ollamaAbsent={ollamaError?.code === 'ollama-absent'}
        listError={ollamaError?.error ?? ''}
        estimates={estimates}
        measurements={measurements}
        calibrating={calibrating}
        calibrateError={calibrateError}
        stopped={stopped === 'calibrate'}
        onStop={stopCalibrate}
        factor={factor}
        defaultFactor={DEFAULT_FACTOR}
        factorIsSet={settings.calibrationFactor !== null}
        derived={derived}
        onCalibrate={calibrate}
        onSetFactor={() => derived !== null && setFactor(Number(derived.toFixed(2)))}
        onResetFactor={() => setFactor(null)}
      />

      <BestFor picks={picks} measured={measuredByTag} contextTokens={tokens(contextTokens)} />

      <ModelList
        rows={shown}
        vramBytes={facts.vramBytes}
        ramBytes={facts.ramBytes}
        liveVram={facts.source === 'collector'}
        freeDiskBytes={facts.freeDiskBytes}
        diskLabel={diskLabel}
        contextTokens={contextTokens}
        maxContext={MAX_CONTEXT}
        onContext={setContextTokens}
        tags={ALL_TAGS}
        filter={filter}
        onFilter={setFilter}
        bandwidthKnown={bandwidthGBs !== null || facts.integrated}
      />
    </div>
  );
};
