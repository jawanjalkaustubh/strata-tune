/**
 * The system report (plan section 17 'About': "our own: snapshot, spec sheet, current
 * sensors, serials redacted — the file people attach to a forum post"), as plain text and
 * as a self-contained HTML page from the same sections. Pure: the modal gathers the inputs
 * and the main process writes the file. Every identifier that could name this one machine
 * is stripped before formatting, and the text is passed through the same rules once more
 * on the way out (plan 27a: serials are never in an export).
 */
import type { SensorMeta, SensorRow, StaticSnapshot, Timers } from '../../collector-types';
import type { AboutSystem, DirectXInfo } from '../../../electron/about';
import { cpuSpec } from '../../analysis/cpuSpec';
import { lookupCpu, lookupGpu } from '../../analysis/hardware-tables';
import { gpuTitle } from '../monitor/vendors';
import { decodeReasons } from '../monitor/reasons';
import { memGbpsOf, nvmlMemOffsetMhz } from '../advisor/thisCard';

export interface SystemReportInput {
  version: string;
  /** ISO. */
  generatedAt: string;
  snapshot: StaticSnapshot | null;
  meta: SensorMeta[];
  latest: SensorRow | null;
  system: AboutSystem | null;
  directx: DirectXInfo | null;
  timers: Timers | null;
}

export interface SystemReport {
  text: string;
  html: string;
  /** "strata-tune-system-report-2026-09-16" without an extension. */
  fileBase: string;
}

/** Plan 27a's footer for every export. */
export const EXPORT_FOOTER = 'Readings come from your drivers and sensors and can be wrong; nothing here is professional advice.';
export const REDACTED = '<redacted>';

// ------------------------------------------------------------ redaction

const SERIAL_KEY = /serial|uuid/i;
// \\?\PCI#VEN_10DE&DEV_2B85&SUBSYS_89EC1043&REV_A1#<instance>#{guid} and PCI\VEN_…\<instance>:
// the instance at the tail is the card's own serial on NVIDIA boards (collector Redact.cs).
const PCI_INSTANCE = /(PCI[#\\]VEN_[0-9A-F]{4}[^#\\\s]*)([#\\])([^#\\\s]+)/gi;
const PCI_UDID = /(PCI_VEN_[0-9A-F]{4}&\S*?REV_[0-9A-F]{2})_\S+/gi;
const SERIAL_LINE = /^([^:\n]*\bSerial(?:\s*Number)?)\s*:.*$/gim;

/** Free text: "Serial Number: …" lines and PCI instance ids, wherever they come from. */
export function redactText(text: string): string {
  return text
    .replace(SERIAL_LINE, `$1: ${REDACTED}`)
    .replace(PCI_INSTANCE, `$1$2${REDACTED}`)
    .replace(PCI_UDID, `$1_${REDACTED}`);
}

/** A deep copy with every serial/uuid-named field replaced and every string passed through redactText. */
export function redact<T>(value: T): T {
  const walk = (v: unknown, key: string): unknown => {
    if (SERIAL_KEY.test(key) && (typeof v === 'string' || typeof v === 'number')) return REDACTED;
    if (typeof v === 'string') return redactText(v);
    if (Array.isArray(v)) return v.map((x) => walk(x, ''));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return walk(value, '') as T;
}

// ------------------------------------------------------------- sections

interface Table {
  header: string[];
  rows: string[][];
}

interface Section {
  title: string;
  rows?: [string, string][];
  table?: Table;
  note?: string;
}

const GIB = 1024 ** 3;
const gb = (bytes: number) => `${Math.round(bytes / 1e9)} GB`;
const gib = (mib: number) => `${Math.round(mib / 1024)} GB`;
const watts = (mw: number) => `${Math.round(mw / 1000)} W`;
const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));
const date = (iso: string) => iso.slice(0, 10);

/** "AMD Ryzen 9 9950X (16C/32T) · NVIDIA GeForce RTX 5090 32 GB, driver 616.92 · 64 GB DDR5-6200 · MSI MAG X870E TOMAHAWK WIFI, BIOS 2.A60 · Windows 11 Home 25H2 build 26200": the Copy hardware summary text. */
export function hardwareSummary(snapshot: StaticSnapshot | null, system: AboutSystem | null): string {
  const parts: string[] = [];
  if (snapshot) {
    const s = snapshot;
    parts.push(`${s.cpu.name.trim()} (${s.cpu.cores}C/${s.cpu.logical}T)`);
    // The title's own " · " (partner · model) would read as two items on this one line.
    for (const g of s.gpus) parts.push(`${gpuTitle(g).replace(' · ', ' ')} ${gib(g.vram.totalMiB)}, driver ${g.driver}`);
    const populated = s.ram.modules.filter((m) => m.capacityMiB > 0);
    const speed = populated.find((m) => m.configuredMts > 0)?.configuredMts;
    parts.push(`${gib(s.ram.totalMiB)} RAM${populated.length ? ` (${populated.length} × ${gib(populated[0].capacityMiB)}${speed ? ` at ${speed} MT/s` : ''})` : ''}`);
    parts.push(`${s.motherboard.manufacturer} ${s.motherboard.product}, BIOS ${s.motherboard.biosVersion}`.trim());
  }
  if (system) parts.push(`${system.windows.name}${system.windows.displayVersion ? ` ${system.windows.displayVersion}` : ''} build ${system.windows.build}`);
  else if (snapshot) parts.push(`${snapshot.os.caption} build ${snapshot.os.build}`);
  return parts.join(' · ');
}

function systemSection(i: SystemReportInput): Section {
  const rows: [string, string][] = [];
  const s = i.snapshot;
  if (i.system) {
    const w = i.system.windows;
    rows.push(['Windows', `${w.name}${w.displayVersion ? ` · ${w.displayVersion}` : ''} · build ${w.build}`]);
  } else if (s) rows.push(['Windows', `${s.os.caption} · build ${s.os.build}`]);
  if (i.directx) {
    for (const d of i.directx.devices) rows.push([`${i.directx.version || 'DirectX'} · ${d.name}`, `feature level ${d.featureLevels[0] ?? 'unknown'}${d.driverModel ? ` · ${d.driverModel}` : ''}${d.driverVersion ? ` · driver ${d.driverVersion}` : ''}`]);
  }
  if (s) {
    rows.push(['Chassis', s.chassis.isLaptop ? 'laptop' : 'desktop']);
    rows.push(['Power plan', `${s.powerPlan.name || 'unknown'}${s.powerPlan.overlayGuid ? ' (with a power-mode overlay)' : ''}`]);
    rows.push(['GPU driver', `${s.gpuDriver.version}${s.gpuDriver.date ? ` (${s.gpuDriver.date})` : ''}`]);
  }
  if (i.system?.health) {
    const h = i.system.health;
    rows.push(['Collector', `${h.version} · PawnIO ${h.pawnIo.installed ? `driver open${h.pawnIo.version ? ` (${h.pawnIo.version})` : ''}` : 'not usable'} · NVML ${h.nvml.available ? `driver ${h.nvml.driver}` : 'absent'}`]);
  }
  rows.push(['Strata Tune', i.version || 'dev']);
  return { title: 'System', rows };
}

function cpuSection(s: StaticSnapshot): Section {
  const rows: [string, string][] = [
    ['Name', s.cpu.name.trim()],
    ['Cores / threads', `${s.cpu.cores} / ${s.cpu.logical}`],
    ['Family / model', `${s.cpu.family} / ${s.cpu.model}`],
    ['Max clock (WMI)', `${s.cpu.maxClockMhz} MHz`]
  ];
  const spec = cpuSpec(s.cpu.name);
  const advisor = lookupCpu(s.cpu.name);
  if (spec) rows.push(['Spec (cpus.json)', `base ${spec.baseMhz} MHz · boost ${spec.boostMhz} MHz · Tjmax ${spec.tjmaxC} °C${spec.stockPowerW ? ` · stock ${spec.powerName} ${spec.stockPowerW} W` : ''}`]);
  if (advisor) rows.push(['Spec (advisor)', `TDP ${advisor.tdpW} W${advisor.npuTops ? ` · NPU ${advisor.npuTops} TOPS` : ''}`]);
  return { title: 'CPU', rows };
}

function boardSection(s: StaticSnapshot): Section {
  const m = s.motherboard;
  return { title: 'Motherboard', rows: [['Board', `${m.manufacturer} ${m.product}`.trim()], ['BIOS', `${m.biosVersion}${m.biosDate ? ` (${m.biosDate})` : ''}`]] };
}

function memorySection(s: StaticSnapshot): Section {
  return {
    title: 'Memory',
    rows: [['Total', gib(s.ram.totalMiB)]],
    table: {
      header: ['Slot', 'Part number', 'Manufacturer', 'Size', 'Configured', 'Reported'],
      rows: s.ram.modules.map((m) => [m.slot, m.partNumber, m.manufacturer, gib(m.capacityMiB), `${m.configuredMts} MT/s`, `${m.reportedMts} MT/s`])
    }
  };
}

function gpuSections(s: StaticSnapshot): Section[] {
  return s.gpus.map((g, n) => {
    const rows: [string, string][] = [
      ['Name', gpuTitle(g)],
      ['Driver', g.driver],
      ['PCIe link', `gen ${g.pcie.currentGen} x${g.pcie.currentWidth} of gen ${g.pcie.maxGen} x${g.pcie.maxWidth}`],
      ['VRAM', `${g.vram.usedMiB} of ${g.vram.totalMiB} MiB used · BAR1 ${g.bar1TotalMiB} MiB`],
      ['Power', `${watts(g.powerMw)} now · limit ${watts(g.powerLimitMw)}${g.powerDefaultLimitMw ? ` · default ${watts(g.powerDefaultLimitMw)}` : ''} · max ${watts(g.powerMaxLimitMw)}`],
      ['Clocks now', `SM ${g.clocks.smMhz} MHz · memory ${g.clocks.memMhz} MHz (${memGbpsOf(g.clocks.memMhz).toFixed(1)} Gbps)`],
      ['Temperature', `${g.temperatureC} °C`],
      ['Load', `GPU ${g.utilisation.gpu} % · memory ${g.utilisation.memory} %`]
    ];
    const reasons = decodeReasons(g.clocksEventReasons.raw).map((r) => r.label);
    if (reasons.length) rows.push(['Limit reasons', reasons.join(', ')]);
    // The driver counts the memory offset on the effective rate (the vendor sliders' unit, twice NVML's clock): printed in NVML MHz beside the NVML ceilings, with the driver's own figure after it, so a reader adds like with like.
    if (g.clockOffsets) {
      const nvmlMem = nvmlMemOffsetMhz(g.clockOffsets);
      rows.push(['Driver offsets', `core ${g.clockOffsets.smMhz ?? '?'} · memory ${nvmlMem ?? '?'} MHz${nvmlMem !== null ? ` (+${g.clockOffsets.memMhz} on the effective rate)` : ''} · ceilings ${g.clockOffsets.maxClockSmMhz ?? '?'} / ${g.clockOffsets.maxClockMemMhz ?? '?'} MHz`]);
    }
    if (g.pstateDeltas) rows.push(['NVAPI P0 deltas', `core ${g.pstateDeltas.coreMhz} · memory ${g.pstateDeltas.memMhz} MHz`]);
    if (g.units) rows.push(['Units (NVAPI)', `${g.units.shaders ?? '?'} shaders · ${g.units.sms ?? '?'} SMs · ${g.units.rops ?? '?'} ROPs · ${g.units.tmus ?? '?'} TMUs`]);
    if (g.pciSubsystem) rows.push(['Subsystem', `vendor 0x${g.pciSubsystem.vendorId.toString(16)} · device 0x${g.pciSubsystem.deviceId.toString(16)}`]);
    const spec = lookupGpu(g.name, g.vram.totalMiB);
    if (spec) {
      rows.push(['Spec (gpus.json)', `${spec.die} · ${spec.shadingUnits} shaders · ${spec.tmus} TMUs · ${spec.rops} ROPs · ${spec.vramGiB} GB ${spec.vramType} ${spec.busBits}-bit · ${spec.memoryGbps} Gbps${spec.bandwidthGBs ? ` (${spec.bandwidthGBs} GB/s)` : ''}`]);
      rows.push(['Spec clocks', `${spec.baseMhz ? `base ${spec.baseMhz} MHz · ` : ''}boost ${spec.boostMhz} MHz · TDP ${spec.tdpW} W`]);
    }
    return { title: s.gpus.length > 1 ? `GPU ${n}` : 'GPU', rows };
  });
}

function storageSection(s: StaticSnapshot): Section {
  const disk = (id: string | null) => s.disks.find((d) => d.deviceId === id)?.friendlyName ?? '';
  return {
    title: 'Storage',
    table: {
      header: ['Disk', 'Type', 'Bus', 'Size'],
      rows: s.disks.map((d) => [d.friendlyName, d.mediaType, d.busType, gb(d.sizeBytes)])
    },
    note: s.volumes.map((v) => `${v.letter}: ${v.label || '(no label)'} · ${v.fileSystem} · ${Math.round(v.freeBytes / GIB)} of ${Math.round(v.sizeBytes / GIB)} GiB free${v.isBoot ? ' · boot' : ''}${disk(v.diskDeviceId) ? ` · on ${disk(v.diskDeviceId)}` : ''}`).join('\n')
  };
}

function timersSection(t: Timers): Section {
  const ms = (v: number | null) => (v === null ? 'unknown' : `${v} ms`);
  const rows: [string, string][] = [
    ['Timer resolution', `${ms(t.currentMs)} now · ${ms(t.finestMs)} finest · ${ms(t.coarsestMs)} default`],
    ['Performance counter', `${t.qpcFrequency} Hz · ${t.qpcSource} (${t.qpcNote})`]
  ];
  if (t.requesters) rows.push(['Holding the timer', t.requesters.length ? t.requesters.map((r) => `${r.name} (pid ${r.pid}${r.own ? ', Strata Tune' : ''}) at ${r.periodMs ?? '?'} ms`).join('; ') : t.requestersNote ?? 'nobody']);
  return { title: 'Timers', rows };
}

function sensorsSection(meta: SensorMeta[], latest: SensorRow | null): Section | null {
  if (!latest) return null;
  const rows: string[][] = [];
  for (const m of meta) {
    const v = latest.values[m.id];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    rows.push([m.hardwareName, m.name, m.sensorType, `${fmt(v)}${m.unit ? ` ${m.unit}` : ''}`]);
  }
  return rows.length ? { title: 'Current sensors', table: { header: ['Hardware', 'Sensor', 'Type', 'Value'], rows } } : null;
}

export function reportSections(raw: SystemReportInput): Section[] {
  const i = redact(raw);
  const sections: Section[] = [systemSection(i)];
  if (i.snapshot) sections.push(cpuSection(i.snapshot), boardSection(i.snapshot), memorySection(i.snapshot), ...gpuSections(i.snapshot), storageSection(i.snapshot));
  if (i.timers) sections.push(timersSection(i.timers));
  const sensors = sensorsSection(i.meta, i.latest);
  if (sensors) sections.push(sensors);
  return sections;
}

// ------------------------------------------------------------- renderers

const TITLE = 'Strata Tune system report';
const NOTE = 'Serial numbers and per-device instance ids are not in this report.';

function toText(i: SystemReportInput, sections: Section[]): string {
  const out: string[] = [`${TITLE} — ${i.generatedAt.replace('T', ' ').slice(0, 16)} UTC — app ${i.version || 'dev'}`, NOTE, ''];
  for (const s of sections) {
    out.push(`== ${s.title} ==`);
    for (const [k, v] of s.rows ?? []) out.push(`${k}: ${v}`);
    if (s.table) {
      const widths = s.table.header.map((h, c) => Math.max(h.length, ...s.table!.rows.map((r) => (r[c] ?? '').length)));
      const line = (cells: string[]) => cells.map((c, n) => (c ?? '').padEnd(widths[n])).join('  ').trimEnd();
      out.push(line(s.table.header), ...s.table.rows.map(line));
    }
    if (s.note) out.push(s.note);
    out.push('');
  }
  out.push(EXPORT_FOOTER);
  return redactText(out.join('\n'));
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function toHtml(i: SystemReportInput, sections: Section[]): string {
  const h = escapeHtml;
  const body = sections
    .map((s) => {
      const rows = (s.rows ?? []).map(([k, v]) => `<tr><th>${h(k)}</th><td>${h(v)}</td></tr>`).join('');
      const table = s.table
        ? `<table class="grid"><thead><tr>${s.table.header.map((c) => `<th>${h(c)}</th>`).join('')}</tr></thead><tbody>${s.table.rows.map((r) => `<tr>${r.map((c) => `<td>${h(c ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table>`
        : '';
      const note = s.note ? `<pre>${h(s.note)}</pre>` : '';
      return `<section><h2>${h(s.title)}</h2>${rows ? `<table class="facts">${rows}</table>` : ''}${table}${note}</section>`;
    })
    .join('\n');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${h(TITLE)}</title>
<style>
body{margin:0;padding:24px;background:#0c0e14;color:#f1f5f9;font:14px/1.5 ui-sans-serif,system-ui,"Segoe UI",sans-serif}
main{max-width:960px;margin:0 auto}h1{font-size:18px;margin:0 0 4px}h2{font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#94a3b8;margin:24px 0 8px}
.meta,footer{color:#64748b;font-size:12px}table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;vertical-align:top;padding:4px 10px 4px 0;border-bottom:1px solid #232938}
.facts th{width:200px;font-weight:500;color:#94a3b8}.grid th{color:#94a3b8;font-weight:500}td,pre{font-variant-numeric:tabular-nums}pre{font:12px/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap;color:#cbd5e1}
footer{margin-top:32px;border-top:1px solid #232938;padding-top:12px}
</style></head><body><main>
<h1>${h(TITLE)}</h1><p class="meta">${h(i.generatedAt.replace('T', ' ').slice(0, 16))} UTC · app ${h(i.version || 'dev')} · ${h(NOTE)}</p>
${body}
<footer>${h(EXPORT_FOOTER)}</footer>
</main></body></html>
`;
  return redactText(html);
}

export function buildSystemReport(input: SystemReportInput): SystemReport {
  const sections = reportSections(input);
  return { text: toText(input, sections), html: toHtml(input, sections), fileBase: `strata-tune-system-report-${date(input.generatedAt)}` };
}
