import React, { useState } from 'react';
import { Check, ClipboardCopy, RotateCcw, ShieldCheck } from 'lucide-react';
import type { TuneExport, TuneStatus } from '../../collector-types';
import { Panel } from '../monitor/Panel';
import { Pill, type Tone } from '../monitor/Pill';
import type { Gates } from './Controls';
import type { TuneAction } from './useTune';
import { pair, STAGE_TONE } from './wire';

interface Props {
  status: TuneStatus;
  export: TuneExport | null;
  gates: Gates;
  busy: TuneAction | null;
  onKeep(): void;
  onRevert(): void;
}

const CONFIDENCE_TONE: Record<TuneExport['confidence'], Tone> = { high: 'ok', medium: 'warn', low: 'idle' };

const when = (iso: string | null) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

/**
 * What the hunts found (plan 16): the result with the baseline it was measured from,
 * the collector's confidence and whether the validate run has passed; Keep puts a
 * validated result on the card for the reboot check, Revert takes anything of Tune's
 * off. Beneath it the state file's history, one line per transition, and the
 * copy-pasteable value set. Nothing is applied for good by this page.
 */
export const Results: React.FC<Props> = ({ status, export: exp, gates, busy, onKeep, onRevert }) => {
  const r = status.result;
  return (
    <Panel kind="Results">
      {r ? (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
          <span className="inline-flex items-baseline gap-2">
            <span className="label">Found · {r.kind} hunt</span>
            <span className="figure text-[12px] text-studio-text whitespace-nowrap">{pair(r.deltas)}</span>
            <span className="figure text-[11px] text-studio-muted whitespace-nowrap" title="The offsets the card ran when the hunt started; the result means nothing from another baseline">
              from {pair(r.baseline)}
            </span>
          </span>
          {r.bandwidthGBs !== null && (
            <span className="inline-flex items-baseline gap-2">
              <span className="label">Bandwidth</span>
              <span className="figure text-[12px] text-studio-text">{r.bandwidthGBs.toFixed(0)} GB/s</span>
            </span>
          )}
          <span className="inline-flex items-center gap-2">
            <span className="label">Confidence</span>
            <Pill tone={CONFIDENCE_TONE[r.confidence]}>{r.confidence}</Pill>
          </span>
          <Pill
            tone={r.validated ? 'ok' : 'warn'}
            title={
              r.promoted
                ? 'Validated, then kept through a clean shutdown and a clean boot: the known-good'
                : r.validated
                  ? `5 min heavy and 2 min transient at your fan curve passed${r.throttledFraction !== null && r.throttledFraction > 0.05 ? ` (power- or thermal-limited ${Math.round(r.throttledFraction * 100)} % of the time, expected at your fan curve)` : ''}`
                  : 'Validate result runs the second phase at your real fan curve'
            }
          >
            {r.promoted ? 'known-good' : r.validated ? 'validated' : 'not yet validated'}
          </Pill>
          <span className="figure text-[11px] text-studio-muted">{when(r.foundAt)}</span>
          <span className="ml-auto inline-flex items-center gap-1">
            <button className="btn h-6" disabled={gates.keep !== null || busy !== null} title={gates.keep ?? 'Put the validated values on the card until the next reboot; a clean shutdown and a clean boot then mark them known-good. They are not re-applied after that: the export text is what persists'} onClick={onKeep}>
              <ShieldCheck size={12} /> Keep
            </button>
            <button className="btn h-6" disabled={gates.revert !== null || busy !== null} title={gates.revert ?? 'Put the baseline back'} onClick={onRevert}>
              <RotateCcw size={12} /> Revert
            </button>
          </span>
        </div>
      ) : (
        <p className="text-mini text-studio-muted">No result yet. A finished hunt lands here with its found values and how sure the collector is of them.</p>
      )}
      {status.history.length > 0 && (
        <table className="w-full text-mini border-collapse mt-2">
          <thead>
            <tr className="text-left">
              {['When', 'State', 'Candidate', 'Note'].map((h) => (
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
                    {h.state.replace('_', ' ')}
                  </Pill>
                </td>
                <td className="figure py-1 pr-3 whitespace-nowrap text-studio-text">{h.candidate ? pair(h.candidate) : '—'}</td>
                <td className="py-1 text-studio-muted">{h.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {exp && <ExportBox export={exp} />}
    </Panel>
  );
};

/** The copy-pasteable value set for Afterburner / GPU Tweak (plan 16), as the collector wrote it: for people who apply the numbers by hand, or on AMD. */
const ExportBox: React.FC<{ export: TuneExport }> = ({ export: e }) => {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard
      ?.writeText(e.text)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };
  return (
    <div className="mt-3 rounded border border-studio-border bg-studio-bg/40 p-3 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <span className="label text-studio-text">Export for Afterburner / GPU Tweak</span>
        <button className="btn h-6" onClick={copy} title="Copy the value set">
          {copied ? <Check size={12} /> : <ClipboardCopy size={12} />} {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="figure text-[12px] text-studio-text whitespace-pre-wrap select-all leading-relaxed">{e.text}</pre>
    </div>
  );
};
