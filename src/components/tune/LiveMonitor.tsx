import React, { useMemo, useRef } from 'react';
import type { GpuFacts, StaticSnapshot, Tick, TuneRun, TuneStatus } from '../../collector-types';
import type { SensorIndex } from '../monitor/sensors';
import type { Ring } from '../monitor/history';
import { Panel } from '../monitor/Panel';
import { Bar, toneByLimit, toneByThresholds } from '../monitor/Bar';
import { Pill, type Tone } from '../monitor/Pill';
import { decodeReasons } from '../monitor/reasons';
import { gpuLayout } from '../monitor/gpuLayout';
import { cpuLayout } from '../monitor/cpuLayout';
import { cpuLimits } from '../monitor/cpuLimits';
import { cpuPowerLimit } from '../monitor/CpuPanel';
import { fanState } from '../monitor/fans';
import { vendorOf, gpuTitle } from '../monitor/vendors';
import { useSettings } from '../useSettings';
import { systemPower } from '../../analysis/power';
import { GPU_IDLE, hasAny, hasBit, IDLE_HINT, POWER_BRAKE, SLOWDOWN, SW_POWER_CAP, THERMAL, THERMAL_OR_BRAKE } from '../../analysis/nvmlBits';
import { pair, rungsOf, signed } from './wire';

interface Props {
  index: SensorIndex;
  tick: Tick;
  ring: Ring;
  snapshot: StaticSnapshot | null;
  status: TuneStatus | null;
  run: TuneRun | null;
}

const watts = (x: number) => `${x.toFixed(0)} W`;
const degrees = (x: number) => `${x.toFixed(0)} °C`;
const mhz = (x: number) => `${x.toFixed(0)} MHz`;
const percent = (x: number) => `${x.toFixed(0)} %`;
const gib = (mib: number) => `${(mib / 1024).toFixed(1)} GiB`;
const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** A numeric fact keeps its one line; a sentence (the last event, a run's closing words) wraps under its label, never past the panel (plan 17a, workflow 13b). */
const Fact: React.FC<{ label: string; value: React.ReactNode; tone?: Tone; wrap?: boolean }> = ({ label, value, tone, wrap }) => (
  <div className={`flex ${wrap ? 'flex-col items-start gap-0.5' : 'items-baseline justify-between gap-3'} min-w-0`}>
    <span className="label whitespace-nowrap">{label}</span>
    <span className={`figure text-[12px] ${wrap ? 'whitespace-normal break-words min-w-0' : 'whitespace-nowrap'} ${tone === 'bad' ? 'text-rose-400' : tone === 'warn' ? 'text-amber-400' : 'text-studio-text'}`}>{value}</span>
  </div>
);

/**
 * The validity pill's words (workflow 13d): the power cap is the normal state of a heavy load
 * on a capped card and reads neutral; heat or the board's power brake is the cooler or the
 * board limiting the clock, amber, never "invalid"; the collector's own verdict (thermal bits
 * on more than 5 % of the sustained samples) says the same in the past tense.
 */
export function validityPill(running: boolean, reasons: number, verdict: TuneRun['validity'] | null): { tone: Tone; text: string } {
  if (!running) return { tone: 'idle', text: 'no test' };
  if (hasAny(reasons, THERMAL)) return { tone: 'warn', text: 'thermal limit — the cooler, not the clock' };
  if (hasAny(reasons, POWER_BRAKE)) return { tone: 'warn', text: 'power brake — the board, not the clock' };
  if (verdict === 'throttled') return { tone: 'warn', text: 'thermal limit during this rung — the cooler, not the clock' };
  if (hasBit(reasons, SW_POWER_CAP)) return { tone: 'info', text: 'on the power cap · normal' };
  return { tone: 'ok', text: 'clean' };
}

/**
 * The live monitor during a test (plan 16): the Monitor page's own bars, pills and
 * helpers over the same 2 Hz ticks, arranged for the question a hunt asks — is the
 * card getting the clock it was asked for, and is anything but the silicon limiting
 * it. Plain DOM at 2 Hz, every bar the shared Bar (plan 17c). The validity pill
 * turns red the moment a thermal or power-brake bit shows during a run, from the
 * live bits or from the collector's verdict, whichever comes first; the power cap is
 * named, never red (plan 16, the user's 600 W budget).
 */
export const LiveMonitor: React.FC<Props> = ({ index, tick, ring, snapshot, status, run }) => {
  const settings = useSettings();
  const gpu: GpuFacts | undefined = tick.gpu[0];
  const gpuName = gpu?.name;
  const layout = useMemo(() => gpuLayout(index, gpuName), [index, gpuName]);
  const cpu = useMemo(() => cpuLayout(index, snapshot?.cpu), [index, snapshot]);
  const vendor = useMemo(() => vendorOf(gpuName), [gpuName]);
  const limits = useMemo(() => cpuLimits(snapshot?.cpu.name), [snapshot]);
  const power = cpuPowerLimit(limits, settings.cpuPptW);
  const dimmCount = snapshot?.ram.modules.length ?? 0;
  const queues = useMemo(() => index.findAll(undefined, 'Factor', /^Disk queue length$/).map((f) => f.meta.id), [index]);
  const spinning = useMemo(() => [...index.findAll(index.hardware(/^(SuperIO|EmbeddedController)$/i), 'Fan', /./), ...index.findAll(index.hardware(/^Gpu/i), 'Fan', /./)].map((f) => f.meta.id), [index]);

  const v = (id?: string) => (id === undefined ? undefined : tick.sensors[id]);
  const hist = (id?: string) => (id === undefined ? undefined : ring.series((t) => t.sensors[id]));
  const g = (pick: (f: GpuFacts) => number) => ring.series((t) => (t.gpu[0] ? pick(t.gpu[0]) : undefined));
  const total = (t: Tick) =>
    systemPower({
      cpuPackageW: cpu.packageW === undefined ? undefined : t.sensors[cpu.packageW],
      gpuBoardW: t.gpu[0] ? t.gpu[0].powerMw / 1000 : undefined,
      dimmCount,
      diskQueues: queues.map((id) => t.sensors[id] ?? 0),
      spinningFans: spinning.filter((id) => (t.sensors[id] ?? 0) > 0).length
    });
  const now = total(tick);
  const totalHigh = Math.max(ring.high((t) => total(t).totalW), now.totalW);
  const totalMax = Math.max(totalHigh * 1.2, 400);

  const running = run?.state === 'running';
  // The validity pill (plan 16, 'the power cap is the normal state'): heat or the board's
  // power brake is the cooler or the board limiting the clock (the collector ends the ladder
  // on it: TuneLadder.ThermalBits, the same bits); the power cap is named for what it is,
  // because every heavy load on a capped card sits on it and the hash, the top-of-curve
  // clock and the throughput decide the rung.
  const reasons = gpu?.clocksEventReasons.raw ?? 0;
  const validity = validityPill(running, reasons, running ? run.validity : null);

  // What the hunt asks the driver for: the clock the card held during the reference phase
  // at the baseline, plus the candidate's core offset (the offsets are 1:1 with the SM
  // clock). Nothing on the wire says it, so it is remembered here per run; a page opened
  // mid-run has no reference and shows the offset alone.
  const reference = useRef({ id: '', smMhz: 0 });
  if (run && reference.current.id !== run.id) reference.current = { id: run.id, smMhz: 0 };
  if (running && run.phase === 'reference' && gpu) reference.current.smMhz = Math.max(reference.current.smMhz, gpu.clocks.smMhz);
  const coreDelta = running && run.candidate ? run.candidate.coreMhz - (status?.baseline?.coreMhz ?? 0) : null;
  const memDelta = running && run.candidate ? run.candidate.memMhz - (status?.baseline?.memMhz ?? 0) : null;
  const requested = coreDelta !== null && reference.current.smMhz > 0 ? reference.current.smMhz + coreDelta : null;

  const gpuBars = (f: GpuFacts) => {
    const powerW = f.powerMw / 1000;
    const limitW = f.powerLimitMw / 1000;
    const maxLimitW = f.powerMaxLimitMw / 1000;
    const idle = hasBit(reasons, GPU_IDLE) || (hasBit(reasons, IDLE_HINT) && f.utilisation.gpu < 5);
    const smHigh = Math.max(ring.high((t) => t.gpu[0]?.clocks.smMhz), f.clocks.smMhz);
    const clockMax = Math.max(smHigh, requested ?? 0, 1500) * 1.05;
    const smTone: Tone = idle ? 'idle' : hasAny(reasons, THERMAL_OR_BRAKE) ? 'bad' : hasBit(reasons, SW_POWER_CAP) ? 'warn' : 'ok';
    const gap = (requested ?? smHigh) - f.clocks.smMhz;
    const memMax = Math.max(ring.high((t) => t.gpu[0]?.clocks.memMhz), f.clocks.memMhz, 1000) * 1.05;
    const fanHigh = Math.max(...layout.fans.map((x) => ring.high((t) => t.sensors[x.id])), 2000);
    return {
      left: (
        <>
          <Bar
            label="GPU board"
            value={powerW}
            format={watts}
            max={Math.max(limitW, maxLimitW, powerW) * 1.05 || 100}
            limit={limitW || undefined}
            limitLabel={`Power limit ${limitW.toFixed(0)} W`}
            mark={maxLimitW && maxLimitW !== limitW ? maxLimitW : undefined}
            markLabel={`Maximum limit ${maxLimitW.toFixed(0)} W`}
            sub={limitW ? `of ${limitW.toFixed(0)} W` : undefined}
            tone={toneByLimit(powerW, limitW || undefined, 0.95)}
            history={g((x) => x.powerMw / 1000)}
          />
          <Bar label="Core temp" value={f.temperatureC} format={degrees} max={100} tone={toneByThresholds(f.temperatureC, 80, 88)} history={g((x) => x.temperatureC)} />
          <Bar label="Memory junction" value={v(layout.memJunction)} format={degrees} max={110} tone={toneByThresholds(v(layout.memJunction) ?? 0, 90, 100)} history={hist(layout.memJunction)} />
          {layout.fans.map((x) => {
            const state = fanState(v(x.id), v(x.duty));
            if (state.unused) return null;
            const duty = v(x.duty);
            return <Bar key={x.id} label={x.name} value={v(x.id)} format={(r) => `${r.toFixed(0)} rpm`} max={fanHigh * 1.1} sub={state.note || duty === undefined ? undefined : `${duty.toFixed(0)} %`} note={state.note} tone={state.tone} history={hist(x.id)} />;
          })}
          <Bar label="VRAM" value={f.vram.usedMiB} format={gib} max={f.vram.totalMiB || 1} sub={`of ${gib(f.vram.totalMiB)}`} tone={toneByLimit(f.vram.usedMiB, f.vram.totalMiB || undefined, 0.9)} history={g((x) => x.vram.usedMiB)} />
        </>
      ),
      right: (
        <>
          <Bar
            label="SM clock"
            value={f.clocks.smMhz}
            format={mhz}
            max={clockMax}
            mark={requested ?? smHigh}
            markLabel={requested !== null ? `Requested ${requested.toFixed(0)} MHz (reference ${reference.current.smMhz} + ${signed(coreDelta ?? 0)})` : `Highest this session ${smHigh.toFixed(0)} MHz`}
            sub={
              // The gap is throttling only under a slowdown bit; under the light pattern the boost governor idles the clock on its own.
              requested !== null
                ? `req ${requested.toFixed(0)}${hasAny(reasons, SLOWDOWN) && gap > 0 ? ` (−${gap.toFixed(0)})` : ''}`
                : coreDelta !== null
                  ? `${signed(coreDelta)} MHz offset`
                  : hasAny(reasons, SLOWDOWN) && gap > 0
                    ? `−${gap.toFixed(0)} MHz`
                    : undefined
            }
            tone={smTone}
            history={g((x) => x.clocks.smMhz)}
          />
          <Bar label="Memory clock" value={f.clocks.memMhz} format={mhz} max={memMax} sub={memDelta !== null ? `${signed(memDelta)} MHz offset` : undefined} tone={idle ? 'idle' : 'ok'} history={g((x) => x.clocks.memMhz)} />
          <Bar label="GPU load" value={f.utilisation.gpu} format={percent} max={100} tone={f.utilisation.gpu < 5 ? 'idle' : 'ok'} history={g((x) => x.utilisation.gpu)} />
          <Bar label="Memory ctrl" value={f.utilisation.memory} format={percent} max={100} tone={f.utilisation.memory < 5 ? 'idle' : 'ok'} history={g((x) => x.utilisation.memory)} />
        </>
      )
    };
  };
  const bars = gpu ? gpuBars(gpu) : null;

  // The test-state block lists what has a value (plan 17a: absent facts collapse, no wall of dashes).
  const facts: { label: string; value: React.ReactNode; tone?: Tone; wrap?: boolean }[] = [];
  if (run && running) {
    if (run.candidate) facts.push({ label: 'Candidate', value: pair(run.candidate) });
    // Counted within the ladder under test, so the number matches the tiles the user is looking at.
    facts.push({ label: 'Ladder', value: run.ladder ? `${run.phase} · ${run.ladder} rung ${rungsOf(run.candidates, run.ladder, [run.asFound]).filter((c) => c.deltas.coreKhz !== (status?.baseline?.coreKhz ?? 0) || c.deltas.memKhz !== (status?.baseline?.memKhz ?? 0)).length + 1}` : run.phase });
    if (run.pattern) facts.push({ label: 'Pattern', value: `${run.pattern} · ${mmss(run.patternElapsedS)} of ${mmss(run.patternSeconds)}` });
    facts.push({ label: 'Elapsed', value: mmss(run.elapsedS) });
    facts.push({ label: 'Errors', value: run.deviceLostCount > 0 ? `${run.errorCount} · ${run.deviceLostCount} device lost` : run.errorCount, tone: run.errorCount > 0 || run.deviceLostCount > 0 ? 'bad' : undefined });
    if (run.bandwidthGBs !== null) facts.push({ label: 'Bandwidth', value: `${run.bandwidthGBs.toFixed(0)} GB/s${run.bestBandwidthGBs !== null ? ` (best ${run.bestBandwidthGBs.toFixed(0)})` : ''}` });
    if (run.lastEvent) facts.push({ label: 'Last', value: run.lastEvent, wrap: true });
  } else if (status?.candidate) {
    facts.push({ label: 'On the card', value: pair(status.candidate) });
  }
  // A run that ended keeps its closing sentence here (why it stopped, or what it found) until the next one starts.
  if (run && !running) facts.push({ label: `Last run · ${run.state}`, value: run.error ?? run.lastEvent, tone: run.state === 'failed' ? 'bad' : undefined, wrap: true });

  return (
    <Panel kind="Live monitor" title={gpu ? gpuTitle(gpu) : undefined} vendor={gpu ? vendor : undefined} aside={gpu && <span className="figure text-[12px] text-studio-muted truncate">driver {gpu.driver}</span>}>
      <div className="split-2">
        <div className="bars space-y-1.5 min-w-0">
          {now.measuredW > 0 && (
            <Bar
              label="Total"
              value={now.totalW}
              format={watts}
              max={totalMax}
              mark={totalHigh}
              markLabel={`Highest this session ${totalHigh.toFixed(0)} W`}
              note={`${now.measuredW.toFixed(0)} W measured · ${now.estimatedW.toFixed(0)} W estimated (${now.parts.filter((p) => p.tag === 'estimated').map((p) => `${p.label.toLowerCase()} ${p.watts.toFixed(0)}`).join(', ')}; no sensor reports these)`}
              tone="ok"
              history={ring.series((t) => total(t).totalW)}
            />
          )}
          <Bar
            label="CPU package"
            value={v(cpu.packageW)}
            format={watts}
            max={Math.max((power.watts ?? 0) * 1.1, ring.high((t) => (cpu.packageW ? t.sensors[cpu.packageW] : undefined)) * 1.1, 100)}
            limit={power.watts}
            limitLabel={`${power.name} ${power.watts ?? 0} W${power.stock ? ' (stock)' : ''}`}
            sub={power.watts ? `of ${power.watts} W${power.stock ? ' stock' : ''}` : undefined}
            tone={toneByLimit(v(cpu.packageW) ?? 0, power.watts)}
            history={hist(cpu.packageW)}
          />
          {bars?.left}
          {!gpu && <p className="text-mini text-studio-muted">The collector reports no NVML GPU.</p>}
        </div>
        <div className="space-y-1.5 min-w-0">
          <div className="bars space-y-1.5 min-w-0">{bars?.right}</div>
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            <span className="label mr-1">Perf limit</span>
            {decodeReasons(reasons).map((r) => (
              <Pill key={r.label} tone={r.tone} className={r.mono ? 'normal-case' : ''} title={`clocks event reasons 0x${reasons.toString(16)}`}>
                {r.label}
              </Pill>
            ))}
            <span className="flex-1" />
            <Pill tone={validity.tone} title="A thermal limit or the board's power brake ends the ladder as the cooler's or the board's limit, not the clock's (plan 16); a power cap is the normal state of a heavy load on a capped card, and the hash, the top-of-curve clock and the throughput decide the rung">
              {validity.text}
            </Pill>
          </div>
          <div className="rounded border border-studio-border bg-studio-bg/40 px-3 py-2 space-y-1">
            {facts.length > 0 ? facts.map((f) => <Fact key={f.label} {...f} />) : <p className="text-mini text-studio-muted">No test running.</p>}
          </div>
        </div>
      </div>
    </Panel>
  );
};
