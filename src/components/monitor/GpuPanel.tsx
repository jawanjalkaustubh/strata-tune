import React, { useMemo } from 'react';
import type { GpuFacts, Tick } from '../../collector-types';
import type { SensorIndex } from './sensors';
import type { Ring } from './history';
import { Panel, type PanelChrome } from './Panel';
import { Bar, toneByLimit, toneByThresholds } from './Bar';
import { Pill, type Tone } from './Pill';
import { PinHeader } from './PinHeader';
import { CardSchematic } from './CardSchematic';
import { SocDiagram } from './SocDiagram';
import { gpuLayout, igpuLayout, otherGpuNodes } from './gpuLayout';
import { NO_CAPS, type Caps } from './caps';
import { decodeReasons } from './reasons';
import { GPU_IDLE, hasAny, hasBit, IDLE_HINT, SLOWDOWN, SW_POWER_CAP, THERMAL_OR_BRAKE } from '../../analysis/nvmlBits';
import { fanState } from './fans';
import { gpuTitle, vendorOf } from './vendors';

interface Props {
  index: SensorIndex;
  tick: Tick;
  ring: Ring;
  panel?: PanelChrome;
  /** Plan 17d rule 2: the capabilities computed once by the page; absent when the panel renders on its own. */
  caps?: Caps;
}

/** The NVML node the rename is keyed by. */
export const gpuKey = (gpu: GpuFacts | undefined) => (gpu ? `/nvml/${gpu.index}` : undefined);

const gib = (mib: number) => `${(mib / 1024).toFixed(1)} GiB`;
const degrees = (x: number) => `${x.toFixed(0)} °C`;
const mhz = (x: number) => `${x.toFixed(0)} MHz`;
const percent = (x: number) => `${x.toFixed(0)} %`;
const watts = (x: number) => `${x.toFixed(1)} W`;

/**
 * The panel for a GPU read through the library alone (plan 17d row 1 and the mid-range row's
 * AMD case, 17c 'No NVIDIA'): an integrated GPU, or a discrete AMD or Intel card the app has
 * no driver API for. Headed by the node's name: core and memory clocks, load, the engine
 * loads that are busy, the card's own VRAM when its driver reports it (else the D3D shared
 * and dedicated figures an iGPU draws from RAM), power, temperature, hot spot and fan. Rows
 * the node does not carry collapse; nothing NVML-shaped is drawn for a card that is not there.
 * On a hybrid laptop the card sleeps while the iGPU drives the desktop, so 0 MHz at idle is
 * the card asleep, not a dead sensor, and the aside names the iGPU beside it.
 */
const LibraryGpuPanel: React.FC<Props> = ({ index, tick, ring, panel, caps = NO_CAPS }) => {
  const dgpuName = caps.dgpu?.name;
  const layout = useMemo(() => igpuLayout(index, undefined, dgpuName), [index, dgpuName]);
  if (!layout) {
    return (
      <Panel kind="GPU" title="GPU" {...panel}>
        <p className="text-mini text-studio-muted">No GPU sensors on this machine: neither NVML nor the library reports a GPU.</p>
      </Panel>
    );
  }
  const v = (id?: string) => (id === undefined ? undefined : tick.sensors[id]);
  const hist = (id?: string) => (id === undefined ? undefined : ring.series((t) => t.sensors[id]));
  const vendor = vendorOf(layout.name);
  // The panel shows a discrete card when the snapshot says this node is one; a card with its own VRAM figure and no adapter list (an older snapshot) counts too.
  const discrete = caps.dgpu ? caps.dgpu.name === layout.name : !!layout.vramTotal && (v(layout.vramTotal) ?? 0) >= 1024;
  const others = otherGpuNodes(index, layout.hardware, undefined);
  const load = v(layout.load) ?? 0;
  const asleep = discrete && (v(layout.clock) ?? 0) === 0 && load < 1;
  // Apple Silicon (the macOS collector): the GPU node carries its core count, and the Neural Engine and memory nodes sit beside it; the SoC diagram is the twin of the CPU's chip diagram.
  const apple = index.meta.find((m) => m.hardware === layout.hardware)?.hardwareType === 'GpuApple';
  const gpuCores = apple ? v(index.find(layout.hardware, 'Factor', /^GPU Cores$/)?.id) : undefined;
  const aside = apple
    ? `${gpuCores ? `${gpuCores}-core GPU · ` : ''}unified memory${caps.dgpu?.driverVersion ? ` · ${caps.dgpu.driverVersion}` : ''}`
    : discrete
    ? `${caps.dgpu?.dedicatedMiB ? `${Math.round(caps.dgpu.dedicatedMiB / 1024)} GB · ` : ''}${caps.dgpu?.driverVersion ? `driver ${caps.dgpu.driverVersion}` : 'discrete card'}`
    : 'integrated · no discrete card';
  const clockHigh = Math.max(ring.high((t) => (layout.clock ? t.sensors[layout.clock] : undefined)), v(layout.clock) ?? 0, 1000);
  const memHigh = Math.max(ring.high((t) => (layout.memClock ? t.sensors[layout.memClock] : undefined)), v(layout.memClock) ?? 0, 1000);
  const powerHigh = Math.max(ring.high((t) => (layout.power ? t.sensors[layout.power] : undefined)), v(layout.power) ?? 0, 15);
  const fanHigh = Math.max(ring.high((t) => (layout.fan ? t.sensors[layout.fan] : undefined)), v(layout.fan) ?? 0, 2000);
  const sharedTotal = v(layout.sharedTotal);
  const vramTotal = v(layout.vramTotal);
  const aneHw = apple ? index.hardware(/^NeuralEngine$/i)[0] : undefined;
  const memoryPowerW = apple ? v(index.find(index.hardware(/^EmbeddedController$/i), 'Power', /^Memory$/)?.id) : undefined;
  const soc = apple && gpuCores ? (
    <SocDiagram
      vendor={vendor}
      gpuCores={gpuCores}
      load={v(layout.load)}
      clockMhz={v(layout.clock)}
      maxClockMhz={caps.dgpu?.maxClockMhz}
      tempC={v(layout.temperature)}
      powerW={v(layout.power)}
      neuralCores={aneHw ? v(index.find(aneHw, 'Factor', /^Cores$/)?.id) : undefined}
      anePowerW={aneHw ? v(index.find(aneHw, 'Power', /^Neural Engine$/)?.id) : undefined}
      memUsedMiB={v(layout.vramUsed)}
      memTotalMiB={vramTotal}
      memoryPowerW={memoryPowerW}
    />
  ) : null;
  const engines = layout.engines.map((e) => ({ name: e.name, load: Math.max(0, ...e.ids.map((id) => tick.sensors[id] ?? 0)) })).filter((e) => e.load > 0);
  const fanRpm = v(layout.fan);
  const fan = fanState(fanRpm, v(layout.fanDuty));
  return (
    <Panel kind="GPU" title={layout.name} nameKey={layout.hardware} vendor={vendor} aside={<span className="figure text-[12px] text-studio-muted truncate">{aside}</span>} {...panel}>
      {discrete && others.length > 0 && (
        <p className="text-mini text-studio-subtle pb-1.5">
          {asleep ? `The card is asleep; ${others[0]} drives the desktop until a game needs it.` : `${others[0]} sits beside it and drives the desktop.`}
        </p>
      )}
      <div className={soc ? 'split' : undefined}>
        {soc && <div className="shrink-0 w-[40%] min-w-[min(100%,280px)] max-w-[min(100%,340px)]">{soc}</div>}
      <div className={`bars space-y-1.5 min-w-0${soc ? ' flex-1' : ''}`}>
        <Bar label="Core clock" value={v(layout.clock)} format={mhz} max={clockHigh * 1.05} mark={clockHigh} markLabel={`Highest this session ${clockHigh.toFixed(0)} MHz`} tone={load < 5 ? 'idle' : 'ok'} history={hist(layout.clock)} />
        {layout.memClock && <Bar label="Memory clock" value={v(layout.memClock)} format={mhz} max={memHigh * 1.05} tone={load < 5 ? 'idle' : 'ok'} history={hist(layout.memClock)} />}
        <Bar label="GPU load" value={v(layout.load)} format={percent} max={100} tone={load < 5 ? 'idle' : 'ok'} history={hist(layout.load)} />
        {engines.map((e) => (
          <Bar key={e.name} label={e.name} value={e.load} format={percent} max={100} tone="ok" />
        ))}
        {discrete && vramTotal ? (
          <Bar label="VRAM" value={v(layout.vramUsed)} format={(x) => gib(x)} max={vramTotal} sub={`of ${gib(vramTotal)}`} tone={toneByLimit(v(layout.vramUsed) ?? 0, vramTotal, 0.9)} history={hist(layout.vramUsed)} />
        ) : (
          <>
            <Bar label="Shared memory" value={v(layout.sharedUsed)} format={(x) => gib(x)} max={sharedTotal || Math.max(v(layout.sharedUsed) ?? 0, 1024)} sub={sharedTotal ? `of ${gib(sharedTotal)} of RAM` : 'from RAM'} tone={toneByLimit(v(layout.sharedUsed) ?? 0, sharedTotal || undefined, 0.9)} history={hist(layout.sharedUsed)} />
            <Bar label="Dedicated" value={v(layout.dedicatedUsed)} format={(x) => `${x.toFixed(0)} MB`} max={Math.max(v(layout.dedicatedUsed) ?? 0, 512)} tone="ok" history={hist(layout.dedicatedUsed)} />
          </>
        )}
        <Bar label="Power" value={v(layout.power)} format={watts} max={powerHigh * 1.1} tone="ok" history={hist(layout.power)} />
        <Bar label="Temperature" value={v(layout.temperature)} format={degrees} max={100} tone={toneByThresholds(v(layout.temperature) ?? 0, 80, 90)} history={hist(layout.temperature)} />
        {layout.hotSpot && <Bar label="Hot spot" value={v(layout.hotSpot)} format={degrees} max={110} tone={toneByThresholds(v(layout.hotSpot) ?? 0, 90, 100)} history={hist(layout.hotSpot)} />}
        {layout.fan && !fan.unused && <Bar label="Fan" value={fanRpm} format={(x) => `${x.toFixed(0)} rpm`} max={fanHigh * 1.1} sub={fan.note || v(layout.fanDuty) === undefined ? undefined : `${v(layout.fanDuty)!.toFixed(0)} %`} note={fan.note} tone={fan.tone} history={hist(layout.fan)} />}
        {layout.fan && fan.unused && <p className="label text-studio-subtle pl-0.5">fan stopped</p>}
      </div>
      </div>
    </Panel>
  );
};

/**
 * Laid out like the CPU panel (phase1-polish item 4): the card schematic on the left with
 * the perf-limit pills under it, the 12V-2x6 block filling the column to its right, the
 * compact bars beneath. The schematic takes 42 % of the panel (300–380 px) so its
 * figures grow with the panel rather than staying a small tile in a wide box. A card
 * without per-pin shunts has no block and no column for it (plan section 17a): the
 * schematic stands alone on its row and the bars carry the board power.
 */
export const GpuPanel: React.FC<Props> = (props) => {
  const { index, tick, ring, panel, caps = NO_CAPS } = props;
  const gpu: GpuFacts | undefined = tick.gpu[0];
  const gpuName = gpu?.name;
  const layout = useMemo(() => gpuLayout(index, gpuName), [index, gpuName]);
  const vendor = useMemo(() => vendorOf(gpuName), [gpuName]);

  // No NVML card: the library's own sensors for the AMD or Intel card or the iGPU, or one sentence and a short panel.
  if (!gpu) return <LibraryGpuPanel {...props} />;

  const v = (id?: string) => (id === undefined ? undefined : tick.sensors[id]);
  const hist = (id?: string) => (id === undefined ? undefined : ring.series((t) => t.sensors[id]));
  const g = (pick: (f: GpuFacts) => number) => ring.series((t) => (t.gpu[0] ? pick(t.gpu[0]) : undefined));

  const powerW = gpu.powerMw / 1000;
  const limitW = gpu.powerLimitMw / 1000;
  const maxLimitW = gpu.powerMaxLimitMw / 1000;
  const powerMax = Math.max(limitW, maxLimitW, powerW) * 1.05 || 100;
  // Plan 17d row 2: on a laptop the limit is the TGP and moves with Dynamic Boost, so it is a band from the TGP to the boosted limit, not one tick.
  const boost = caps.dynamicBoost && maxLimitW > limitW;
  const reasons = gpu.clocksEventReasons.raw;
  const idle = hasBit(reasons, GPU_IDLE) || (hasBit(reasons, IDLE_HINT) && gpu.utilisation.gpu < 5);
  // The reference is the highest SM clock this session: a gap below it means something
  // only when the driver says so with a slowdown bit (plan 17a); otherwise it is the boost
  // governor, and the perf-limit pills carry the reason.
  const smHigh = Math.max(ring.high((t) => t.gpu[0]?.clocks.smMhz), gpu.clocks.smMhz);
  const clockMax = Math.max(smHigh, 1500) * 1.05;
  const slowed = hasAny(reasons, SLOWDOWN);
  const gap = smHigh - gpu.clocks.smMhz;
  const smTone: Tone = idle ? 'idle' : hasAny(reasons, THERMAL_OR_BRAKE) ? 'bad' : hasBit(reasons, SW_POWER_CAP) ? 'warn' : 'ok';
  const memMax = Math.max(ring.high((t) => t.gpu[0]?.clocks.memMhz), gpu.clocks.memMhz, 1000) * 1.05;
  const fanHigh = Math.max(...layout.fans.map((f) => ring.high((t) => t.sensors[f.id])), 2000);
  const unusedFans = layout.fans.filter((f) => fanState(v(f.id), v(f.duty)).unused).length;
  const engineLoad = (ids: string[]) => Math.max(0, ...ids.map((id) => tick.sensors[id] ?? 0));
  const connectorA = v(layout.connectorA);
  const pills = (
    <div className="flex flex-wrap items-center gap-1.5 pt-1">
      <span className="label mr-1">Perf limit</span>
      {decodeReasons(reasons).map((r) => (
        <Pill key={r.label} tone={r.tone} className={r.mono ? 'normal-case' : ''} title={`clocks event reasons 0x${reasons.toString(16)}`}>
          {r.label}
        </Pill>
      ))}
    </div>
  );

  return (
    <Panel kind="GPU" title={gpuTitle(gpu)} nameKey={gpuKey(gpu)} vendor={vendor} aside={<span className="figure text-[12px] text-studio-muted truncate">driver {gpu.driver}</span>} {...panel}>
      <div className="split">
        <div className={`shrink-0 ${layout.pins.length > 0 ? 'w-[42%] min-w-[min(100%,300px)] max-w-[min(100%,380px)]' : 'w-full max-w-[520px]'} space-y-1.5`}>
          <CardSchematic
            vendor={vendor}
            coreC={gpu.temperatureC}
            hotSpotC={v(layout.hotSpot)}
            coreV={v(layout.coreV)}
            smMhz={gpu.clocks.smMhz}
            memMhz={gpu.clocks.memMhz}
            vramUsedMiB={gpu.vram.usedMiB}
            vramTotalMiB={gpu.vram.totalMiB}
            memJunctionC={v(layout.memJunction)}
            pcie={{ gen: gpu.pcie.currentGen, width: gpu.pcie.currentWidth, maxGen: gpu.pcie.maxGen, maxWidth: gpu.pcie.maxWidth }}
            rx={v(layout.rx)}
            tx={v(layout.tx)}
            rxHistory={hist(layout.rx)}
            txHistory={hist(layout.tx)}
            fans={layout.fans.map((f) => ({ name: f.name, rpm: v(f.id), duty: v(f.duty), history: hist(f.id) }))}
            engines={layout.engines.map((e) => ({ name: e.name, load: engineLoad(e.ids) }))}
            connectorW={v(layout.connectorW)}
            connectorA={connectorA}
            idle={idle}
            histories={{ coreC: g((f) => f.temperatureC), vramUsedMiB: g((f) => f.vram.usedMiB) }}
          />
          {pills}
        </div>
        {layout.pins.length > 0 && (
          <div className="flex-1 min-w-0">
            <PinHeader
              pins={layout.pins.map((p) => ({ n: p.n, amps: v(p.ampsId), volts: v(p.voltsId), watts: v(p.wattsId) }))}
              totalAmps={connectorA}
              totalWatts={v(layout.connectorW)}
              history={(p) => hist(layout.pins.find((x) => x.n === p.n)?.ampsId)}
            />
          </div>
        )}
      </div>
      <div className="split-2 pt-1">
        <div className="bars space-y-1.5 min-w-0">
          <Bar label="Core temp" value={gpu.temperatureC} format={degrees} max={100} tone={toneByThresholds(gpu.temperatureC, 80, 88)} history={g((f) => f.temperatureC)} />
          <Bar label="Hot spot" value={v(layout.hotSpot)} format={degrees} max={110} tone={toneByThresholds(v(layout.hotSpot) ?? 0, 90, 100)} history={hist(layout.hotSpot)} />
          <Bar label="Memory junction" value={v(layout.memJunction)} format={degrees} max={110} tone={toneByThresholds(v(layout.memJunction) ?? 0, 90, 100)} history={hist(layout.memJunction)} />
          <Bar
            label="Board power"
            value={powerW}
            format={(x) => `${x.toFixed(0)} W`}
            max={powerMax}
            limit={boost ? undefined : limitW || undefined}
            limitLabel={`Power limit ${limitW.toFixed(0)} W`}
            mark={boost ? maxLimitW : maxLimitW && maxLimitW !== limitW ? maxLimitW : undefined}
            markLabel={boost ? `Dynamic Boost up to ${maxLimitW.toFixed(0)} W` : `Maximum limit ${maxLimitW.toFixed(0)} W`}
            band={boost ? [limitW, maxLimitW] : undefined}
            sub={boost ? `TGP ${limitW.toFixed(0)} W` : limitW ? `of ${limitW.toFixed(0)} W` : undefined}
            note={boost ? `Dynamic Boost up to ${maxLimitW.toFixed(0)} W` : undefined}
            tone={toneByLimit(powerW, (boost ? maxLimitW : limitW) || undefined, 0.95)}
            history={g((f) => f.powerMw / 1000)}
          />
          <Bar
            label="VRAM"
            value={gpu.vram.usedMiB}
            format={gib}
            max={gpu.vram.totalMiB || 1}
            sub={`of ${gib(gpu.vram.totalMiB)}`}
            tone={toneByLimit(gpu.vram.usedMiB, gpu.vram.totalMiB || undefined, 0.9)}
            history={g((f) => f.vram.usedMiB)}
          />
          {layout.fans.map((f) => {
            const rpm = v(f.id);
            const duty = v(f.duty);
            const state = fanState(rpm, duty);
            if (state.unused) return null;
            return (
              <Bar
                key={f.id}
                label={f.name}
                value={rpm}
                format={(x) => `${x.toFixed(0)} rpm`}
                max={fanHigh * 1.1}
                sub={state.note || duty === undefined ? undefined : `${duty.toFixed(0)} %`}
                note={state.note}
                tone={state.tone}
                history={hist(f.id)}
              />
            );
          })}
          {unusedFans > 0 && <p className="label text-studio-subtle pl-0.5">{`${unusedFans} fan${unusedFans > 1 ? 's' : ''} stopped`}</p>}
        </div>
        <div className="bars space-y-1.5 min-w-0">
          <Bar
            label="SM clock"
            value={gpu.clocks.smMhz}
            format={mhz}
            max={clockMax}
            mark={smHigh}
            markLabel={`Highest this session ${smHigh.toFixed(0)} MHz`}
            sub={slowed && gap > 0 ? `−${gap.toFixed(0)} MHz` : undefined}
            tone={smTone}
            history={g((f) => f.clocks.smMhz)}
          />
          <Bar label="Memory clock" value={gpu.clocks.memMhz} format={mhz} max={memMax} tone={idle ? 'idle' : 'ok'} history={g((f) => f.clocks.memMhz)} />
          <Bar label="GPU load" value={gpu.utilisation.gpu} format={percent} max={100} tone={gpu.utilisation.gpu < 5 ? 'idle' : 'ok'} history={g((f) => f.utilisation.gpu)} />
          {/* No bus-load bar: LHM's "GPU Bus" (NVAPI's bus utilisation domain) reads 57–100 % on this idle RTX 5090; the PCIe edge's Rx/Tx sparkline is the honest link figure. */}
          <Bar label="Memory ctrl" value={gpu.utilisation.memory} format={percent} max={100} tone={gpu.utilisation.memory < 5 ? 'idle' : 'ok'} history={g((f) => f.utilisation.memory)} />
        </div>
      </div>
    </Panel>
  );
};
