import React, { useState } from 'react';
import { Check, ClipboardCopy, FileDown, RotateCcw } from 'lucide-react';
import type { TuneExport, TuneResult, TuneStatus } from '../../collector-types';
import { DEVICE_CLASS_LABEL, exportText, holdsNowLine, leftSentence, percentOver, REFERENCE_POINTS, scoreLine, signedPercent, sliderTotal, vendorSlider, type DeviceClass } from '../../analysis/tune';
import { lookupGpu, type GpuSpec } from '../../analysis/hardware-tables';
import { memGbpsOf } from '../advisor/thisCard';
import { Panel } from '../monitor/Panel';
import { Pill, type Tone } from '../monitor/Pill';
import type { Gates } from './Controls';
import type { TuneAction } from './useTune';
import { additivityOf, confidenceWhy, pair, points, signed, STAGE_TONE, STOP_TEXT } from './wire';

interface Props {
  status: TuneStatus;
  export: TuneExport | null;
  gates: Gates;
  busy: TuneAction | null;
  deviceClass: DeviceClass | null;
  /** The card's name, for the reference row of the table (src/data/gpus.json). */
  gpuName: string | undefined;
  onRevert(): void;
  /** Save the comparison sheet (plan section 16, the .html); absent outside Electron. */
  onSave: (() => void) | null;
}

const CONFIDENCE_TONE: Record<TuneExport['confidence'], Tone> = { high: 'ok', medium: 'warn', low: 'idle' };

const when = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

const day = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : d.toLocaleDateString();
};

/** The export's own text when the collector wrote it, else the same lines from the TS mirror (a fixture, a result the export did not carry). */
export const textOf = (r: TuneResult, exp: TuneExport | null) => exp?.text || exportText(r, day(r.foundAt));

const nothingCertified = (r: TuneResult) => r.certified.coreMhz === 0 && r.certified.memMhz === 0;

/** "3225 MHz · 32.0 Gbps" for a memory clock, "3225 MHz" for the SM. */
const mem = (mhz: number) => `${mhz} MHz · ${memGbpsOf(mhz).toFixed(1)} Gbps`;

/**
 * The current OC · reference · certified table (phase 8 follow-up item 4, plan section 16):
 * the card as found, the reference design from gpus.json, and what the ladders certified.
 * The board's rated column waits for boards.json (nothing is invented, so no column of
 * "unknown"; plan 17a); a card outside gpus.json drops the reference column and says so in
 * one sentence. Rows the run did not measure say so instead of a dash.
 */
const Table: React.FC<{ r: TuneResult; spec: GpuSpec | null }> = ({ r, spec }) => {
  const found = r.baselineHeld;
  const cert = r.heldAtCertified;
  const refMem = spec ? spec.memoryGbps : null;
  const rows: { label: string; current: string; reference: string; certified: string }[] = [
    {
      label: 'SM clock',
      current: found ? `${found.smMhz} MHz` : 'not measured',
      reference: spec ? `${spec.boostMhz} MHz boost` : '',
      certified: cert ? `${cert.smMhz} MHz` : nothingCertified(r) ? 'nothing above as found' : 'not measured'
    },
    {
      label: 'Memory clock',
      current: found ? mem(found.memMhz) : 'not measured',
      reference: refMem ? `${refMem} Gbps · ${Math.round((refMem * 1000) / 2)} MHz` : '',
      certified: cert ? mem(cert.memMhz) : nothingCertified(r) ? 'nothing above as found' : 'not measured'
    },
    {
      label: 'Offsets',
      current: r.vendor ? `vendor tool core +${r.vendor.coreMhz} / memory +${r.vendor.memMhz}` : r.baseline.coreMhz || r.baseline.memMhz ? pair(r.baseline) : 'none (stock)',
      reference: spec ? 'none' : '',
      certified: nothingCertified(r) ? 'none' : `${pair(r.certified)} on top`
    }
  ];
  const columns = spec ? ['Current OC', 'Reference', 'Certified'] : ['Current OC', 'Certified'];
  return (
    <div className="space-y-1 min-w-0">
      <table className="w-full text-mini border-collapse">
        <thead>
          <tr className="text-left">
            <th className="label font-normal pb-1 pr-3" />
            {columns.map((h) => (
              <th key={h} className="label font-normal pb-1 pr-3">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className="border-t border-studio-border align-baseline">
              <td className="label py-1 pr-3 whitespace-nowrap">{row.label}</td>
              <td className="figure py-1 pr-3 text-studio-text">{row.current}</td>
              {spec && <td className="figure py-1 pr-3 text-studio-muted">{row.reference}</td>}
              <td className="figure py-1 text-studio-text">{row.certified}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!spec && <p className="text-micro text-studio-subtle">No reference figures for this GPU yet: the table compares the card with itself, and the board's rated figures wait for a board table.</p>}
    </div>
  );
};

/**
 * What the hunt found (plan sections 16, 17; phase 8 follow-up items 7 and 9): the score
 * line first, then the value set with Copy in our units and the vendor slider's units (the
 * collector's own conversion, never re-derived here), the sentence that says where the
 * values go, the additivity check, the first failure with its stage, the truth line about
 * what the card holds now, and the current OC · board · reference · certified table. Revert
 * takes anything of Tune's off the card; nothing is applied for good by this page.
 */
export const Results: React.FC<Props> = ({ status, export: exp, gates, busy, deviceClass, gpuName, onRevert, onSave }) => {
  const r = status.result;
  const [copied, setCopied] = useState(false);
  const spec = gpuName ? lookupGpu(gpuName) : null;
  const copy = () => {
    if (!r) return;
    navigator.clipboard
      ?.writeText(textOf(r, exp))
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };
  return (
    <Panel kind="Result">
      {r ? (
        <div className="space-y-3 min-w-0">
          <ScoreLine r={r} deviceClass={deviceClass} />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <span className="inline-flex items-center gap-2 min-w-0">
              <span className="label">Confidence</span>
              <Pill tone={CONFIDENCE_TONE[r.confidence]}>{r.confidence}</Pill>
              <span className="text-micro text-studio-subtle whitespace-normal break-words">{confidenceWhy(r)}</span>
            </span>
            <span className="figure text-[11px] text-studio-muted">{when(r.foundAt)}</span>
            <span className="flex-1" />
            <button className="btn h-6" onClick={copy} title="Copy the value set as text">
              {copied ? <Check size={12} /> : <ClipboardCopy size={12} />} {copied ? 'Copied' : 'Copy'}
            </button>
            {onSave && (
              <button className="btn h-6" onClick={onSave} title="Save the scored run as one self-contained .html: score, rungs, clocks, temperatures and power per component">
                <FileDown size={12} /> Save as .html
              </button>
            )}
            <button className="btn h-6" disabled={gates.revert !== null || busy !== null} title={gates.revert ?? 'Put the baseline back'} onClick={onRevert}>
              <RotateCcw size={12} /> Revert
            </button>
          </div>
          <ValueSet r={r} exp={exp} />
          <Checks r={r} />
          <p className="text-mini text-studio-text">{holdsNowLine(r)}</p>
          <Table r={r} spec={spec} />
        </div>
      ) : (
        <p className="text-mini text-studio-muted">No result yet. A finished hunt lands here with its score, the values to type into your vendor tool and what the card held.</p>
      )}
      {status.history.length > 0 && (
        <details className="mt-3">
          <summary className="label cursor-pointer select-none">State file history ({status.history.length})</summary>
          <table className="w-full text-mini border-collapse mt-2">
            <thead>
              <tr className="text-left">
                {['When', 'State', 'Rung', 'Note'].map((h) => (
                  <th key={h} className="label font-normal pb-1 pr-3">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...status.history].reverse().map((h, i) => (
                <tr key={i} className="border-t border-studio-border align-baseline">
                  <td className="figure py-1 pr-3 whitespace-nowrap text-studio-muted">{when(h.at)}</td>
                  <td className="py-1 pr-3">
                    <Pill tone={STAGE_TONE[h.state]} className="normal-case tracking-normal">
                      {h.state}
                    </Pill>
                  </td>
                  <td className="figure py-1 pr-3 whitespace-nowrap text-studio-text">{h.candidate ? pair(h.candidate) : 'none'}</td>
                  <td className="py-1 text-studio-muted">{h.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </Panel>
  );
};

/** "11,812 points at +45 / +60: +0.9 % over your current tune (11,701), +18.1 % over an estimated reference 5090 (10,000)", with the device class beside it (plan 17d rule 3). */
const ScoreLine: React.FC<{ r: TuneResult; deviceClass: DeviceClass | null }> = ({ r, deviceClass }) => {
  const official = r.official?.score;
  const found = r.asFound?.score;
  const headline = official ? points(official.points) : found ? points(found.points) : null;
  const line = scoreLine(r);
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 min-w-0">
      {headline && (
        <span className="figure text-2xl text-studio-text leading-none">
          {headline} <span className="text-mini text-studio-muted">points</span>
        </span>
      )}
      {official && found && (
        <span className={`figure text-[12px] ${official.points >= found.points ? 'text-emerald-400' : 'text-amber-300'}`} title="Against the card as found">
          {signedPercent(percentOver(official.points, found.points))} over your current tune
        </span>
      )}
      {headline && (
        <span className="figure text-[12px] text-studio-muted" title={`${points(REFERENCE_POINTS)} is where a reference RTX 5090 at reference clocks (2407 MHz boost, 28 Gbps) would land, estimated by scaling this kernel's measured cost; no reference card was measured`}>
          {signedPercent(percentOver((official ?? found)!.points, REFERENCE_POINTS))} over an estimated reference 5090
        </span>
      )}
      {deviceClass && <Pill tone="idle" className="normal-case tracking-normal" title="Scores are on one absolute scale; the class says what kind of machine this is">{DEVICE_CLASS_LABEL[deviceClass]}</Pill>}
      <span className="basis-full text-mini text-studio-muted whitespace-normal break-words">{line ?? 'The card as found was not scored: an older result, or a run that ended before its two-minute measurement.'}</span>
    </div>
  );
};

/**
 * The value set (plan 16), labelled by what the user does with each pair: the numbers to type
 * into the vendor tool first and largest (the whole tune when the hunt climbed on top of one,
 * else the certified offsets in the slider's units), then what sits on top of the user's own
 * tune in slider units, then the certified pair in our NVML units. The sentence beneath says
 * how the card was left: on a vendor tune it now holds the tune through our P0 route, so the
 * vendor tool may need one Apply (the export's own words, leftSentence).
 */
const ValueSet: React.FC<{ r: TuneResult; exp: TuneExport | null }> = ({ r, exp }) => {
  const c = r.certified;
  const slider = exp?.vendorSlider ?? vendorSlider(c);
  const total = exp?.sliderTotal ?? (r.vendor ? sliderTotal(r.vendor, c) : null);
  const held = r.baselineHeld && r.heldAtCertified ? `${r.baselineHeld.smMhz} / ${r.baselineHeld.memMhz} → ${r.heldAtCertified.smMhz} / ${r.heldAtCertified.memMhz} MHz` : null;
  if (nothingCertified(r)) {
    return (
      <div className="rounded border border-studio-border bg-studio-bg/40 p-3 space-y-1">
        <p className="text-mini text-studio-text">Nothing above the card as found could be certified; there are no values to type anywhere.</p>
        {held && <p className="figure text-[12px] text-studio-muted">as found {r.baselineHeld!.smMhz} / {r.baselineHeld!.memMhz} MHz</p>}
        <p className="text-mini text-studio-muted whitespace-normal break-words">{leftSentence(r)}</p>
      </div>
    );
  }
  const type = total && r.vendor ? total : slider;
  return (
    <div className="rounded border border-studio-border bg-studio-bg/40 p-3 space-y-1.5 min-w-0">
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1.5">
        <span className="inline-flex flex-wrap items-baseline gap-x-2">
          <span className="label">Type into GPU Tweak / Afterburner</span>
          <span className="figure text-[15px] text-emerald-400 whitespace-nowrap" title={total && r.vendor ? `Your +${r.vendor.coreMhz} / +${r.vendor.memMhz} plus what was certified on top; their memory slider counts the effective rate, twice ours` : 'Their memory slider counts the effective rate, twice ours'}>
            core {signed(type.coreMhz)} · memory {signed(type.memMhz)}
          </span>
        </span>
        {total && r.vendor && (
          <span className="inline-flex flex-wrap items-baseline gap-x-2">
            <span className="label">On top of your tune (slider units)</span>
            <span className="figure text-[12px] text-studio-muted whitespace-nowrap" title={`Above your +${r.vendor.coreMhz} / +${r.vendor.memMhz}, in the slider's units`}>
              core {signed(slider.coreMhz)} · memory {signed(slider.memMhz)}
            </span>
          </span>
        )}
        <span className="inline-flex flex-wrap items-baseline gap-x-2">
          <span className="label">Certified on top (NVML MHz)</span>
          <span className="figure text-[12px] text-studio-muted whitespace-nowrap">{pair(c)}</span>
        </span>
        {held && <span className="figure text-[11px] text-studio-muted whitespace-nowrap">{held}</span>}
      </div>
      <p className="text-mini text-studio-text whitespace-normal break-words">{leftSentence(r)}</p>
    </div>
  );
};

/** The additivity check per ladder, the first failure with its stage, and how each ladder ended. */
const Checks: React.FC<{ r: TuneResult }> = ({ r }) => {
  const adds = additivityOf(r);
  const f = r.firstFailure;
  return (
    <div className="space-y-0.5 text-mini">
      {adds.map((a) => (
        <p key={a.ladder} className={a.passed ? 'text-studio-muted' : 'text-amber-300'}>
          <span className="label mr-2">{a.ladder} additivity</span>
          {a.passed ? `the driver added our offset: ${a.text}` : a.text}
        </p>
      ))}
      <p className={f ? 'text-rose-300' : 'text-studio-muted'}>
        <span className="label mr-2">First failure</span>
        {f ? `${STOP_TEXT[f.reason]} at ${signed(f.offsetMhz)} ${f.ladder}${f.stage ? ` (stage ${f.stage})` : ''}${f.note ? `: ${f.note}` : ''}` : 'none: no rung failed a stage of the ladder'}
      </p>
      {r.stops
        // A stop the additivity row already shows in full (the driver not adding; the top of the table at +0) is not printed twice.
        .filter((s) => (!f || s.ladder !== f.ladder || s.reason !== f.reason) && !(s.reason === 'additivity' || (s.reason === 'top-of-table' && s.offsetMhz === 0)))
        .map((s) => (
          <p key={`${s.ladder}-${s.reason}`} className="text-studio-muted">
            <span className="label mr-2">{s.ladder} ladder ended</span>
            {STOP_TEXT[s.reason]} at {signed(s.offsetMhz)}
            {s.note ? `: ${s.note}` : ''}
          </p>
        ))}
    </div>
  );
};
