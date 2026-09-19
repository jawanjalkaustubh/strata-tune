import React, { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Pill, type Tone } from '../monitor/Pill';
import { Meter } from './Meter';
import { MoeTag, MtpTag, Tag } from './Tag';
import { gib, tokS, tokens } from './format';
import type { Bucket, ViewRow } from './rows';

const BUCKET: Record<Bucket, { label: string; tone: Tone }> = {
  fast: { label: 'Runs fast', tone: 'ok' },
  tight: { label: 'Runs, tight', tone: 'warn' },
  slow: { label: 'Runs slowly', tone: 'idle' },
  no: { label: "Won't run", tone: 'bad' }
};

interface Props {
  rows: ViewRow[];
  vramBytes: number;
  /** The RAM the CPU-only rows are measured against (plan 17d row 1). */
  ramBytes: number;
  /** The VRAM figures are live (collector connected), so "loads now" means something. */
  liveVram: boolean;
  freeDiskBytes: number | null;
  diskLabel: string;
  contextTokens: number;
  maxContext: number;
  onContext: (tokens: number) => void;
  tags: string[];
  filter: string | null;
  onFilter: (tag: string | null) => void;
  bandwidthKnown: boolean;
}

export const MIN_CONTEXT = 512;
const COPIED_MS = 1500;

/** Log scale: half the slider is 512 → 8k, the other half 8k → the largest window in the table. */
const toSlider = (tokens: number, max: number) => Math.log2(tokens / MIN_CONTEXT) / Math.log2(max / MIN_CONTEXT);
const fromSlider = (t: number, max: number) => {
  const raw = MIN_CONTEXT * Math.pow(max / MIN_CONTEXT, t);
  const step = raw < 4096 ? 256 : raw < 32768 ? 1024 : 4096;
  return Math.min(max, Math.max(MIN_CONTEXT, Math.round(raw / step) * step));
};

/** Plan section 10: the next step for most people is a first download, so the pull command is one click away. */
const PullCommand: React.FC<{ tag: string }> = ({ tag }) => {
  const command = `ollama pull ${tag}`;
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(id);
  }, [copied]);
  const copy = () => navigator.clipboard?.writeText(command).then(() => setCopied(true), () => setCopied(false));
  return (
    <button
      className={`inline-flex items-center gap-1 text-[10px] figure truncate max-w-full ${copied ? 'text-emerald-400' : 'text-studio-subtle hover:text-studio-text'}`}
      onClick={copy}
      title={copied ? 'Copied' : `Copy "${command}"`}
    >
      {copied ? <Check size={10} /> : <Copy size={10} />}
      <span className="truncate">{copied ? 'copied' : tag}</span>
    </button>
  );
};

/** The advisor's rows in its own order (largest model that still runs fast first); the bar is required VRAM against the card's. */
export const ModelList: React.FC<Props> = (p) => {
  const barMax = p.vramBytes * 1.25;
  const grid = 'grid items-center gap-x-3 px-3 grid-cols-[minmax(9rem,1.3fr)_minmax(8rem,1.6fr)_minmax(16rem,1.4fr)_minmax(6rem,auto)] min-w-0';
  return (
    <section className="rounded-md border border-studio-border bg-studio-panel min-w-0">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2 border-b border-studio-border">
        <h2 className="label">Models</h2>
        <label className="flex items-center gap-2 min-w-[16rem] flex-1 max-w-md">
          <span className="label whitespace-nowrap">Context</span>
          <input
            type="range"
            min={0}
            max={1000}
            value={Math.round(toSlider(p.contextTokens, p.maxContext) * 1000)}
            onChange={(e) => p.onContext(fromSlider(Number(e.target.value) / 1000, p.maxContext))}
            className="flex-1 accent-emerald-500 h-1.5"
            aria-label="Context length in tokens"
          />
          <span className="figure text-mini text-studio-text w-14 text-right">{tokens(p.contextTokens)}</span>
        </label>
        <div className="flex items-center gap-1 flex-wrap">
          {[null, ...p.tags].map((t) => (
            <button
              key={t ?? 'all'}
              onClick={() => p.onFilter(t)}
              className={`inline-flex items-center h-5 px-1.5 rounded border label transition-colors ${
                p.filter === t ? 'text-emerald-400 border-emerald-500/40 bg-emerald-500/10' : 'text-studio-muted border-studio-border hover:border-studio-border-light'
              }`}
            >
              {t ?? 'all'}
            </button>
          ))}
        </div>
      </header>

      <div className={`${grid} py-1 border-b border-studio-border text-[10px] text-studio-subtle`}>
        <span className="label">model · ollama pull tag</span>
        <span className="flex items-center gap-1.5">
          <span className="label">{p.rows.some((r) => r.cpuOnly) ? 'required RAM' : 'required VRAM'}</span> <Tag kind="estimated" />
        </span>
        <span className="flex items-center gap-1.5">
          <span className="label">verdict · tok/s</span> <Tag kind="estimated" />
        </span>
        <span className="flex items-center gap-1.5 justify-end">
          <span className="label">download</span> <Tag kind="spec" />
        </span>
      </div>

      <div className="divide-y divide-studio-border">
        {p.rows.length === 0 && <p className="px-3 py-3 text-mini text-studio-muted">No model carries that tag.</p>}
        {p.rows.map((r) => {
          const b = BUCKET[r.bucket];
          const fits = p.freeDiskBytes === null ? null : r.fitsOnDisk;
          return (
            <div key={r.key} className={`${grid} py-1.5`}>
              <div className="min-w-0">
                <div className="text-mini text-studio-text truncate">{r.name}</div>
                <div className="flex items-center gap-1.5 min-w-0 text-[10px] text-studio-subtle figure">
                  <span className="whitespace-nowrap">{r.quantLabel}</span>
                  <span className="text-studio-border">·</span>
                  <PullCommand tag={r.pullTag} />
                  {r.contextCapped && <span className="text-amber-400/80 whitespace-nowrap">· max {tokens(r.maxContext)} ctx</span>}
                </div>
              </div>

              <div className="min-w-0">
                {r.cpuOnly ? (
                  <Meter value={r.requiredBytes} max={p.ramBytes * 1.25} tick={p.ramBytes} tickLabel={`RAM ${gib(p.ramBytes, 0)}`} tone={r.bucket === 'no' ? 'bad' : 'idle'} title={`${gib(r.requiredBytes)} of ${gib(p.ramBytes, 0)} RAM, shared with the desktop`} />
                ) : (
                  <Meter value={r.requiredBytes} max={barMax} tick={p.vramBytes} tickLabel={`VRAM ${gib(p.vramBytes, 0)}`} tone={b.tone} title={`${gib(r.requiredBytes)} of ${gib(p.vramBytes, 0)} VRAM`} />
                )}
                <div className="flex justify-between gap-2 text-[10px] text-studio-subtle mt-0.5 figure">
                  <span>
                    {gib(r.requiredBytes)} <span className="text-studio-subtle/70">of {r.cpuOnly ? `${gib(p.ramBytes, 0)} RAM` : gib(p.vramBytes, 0)}</span>
                  </span>
                  <span>
                    {r.cpuOnly ? (r.bucket === 'no' ? 'more than RAM can hold' : 'from RAM') : r.headroomBytes >= 0 ? `${gib(r.headroomBytes)} free` : `${gib(-r.headroomBytes)} over`}
                    {p.liveVram && r.bucket !== 'no' && !r.fitsNow && (
                      <span className="ml-1.5 text-amber-400/80" title="Another app holds video memory right now; the verdict judges the card's total">
                        · VRAM busy now
                      </span>
                    )}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-2 min-w-0 flex-wrap">
                <Pill tone={r.cpuOnly && r.bucket === 'slow' ? 'idle' : b.tone}>{r.cpuOnly && r.bucket === 'slow' ? 'Runs on the CPU' : b.label}</Pill>
                {r.tokPerSec !== null && r.bucket !== 'no' ? (
                  <span className="figure text-mini whitespace-nowrap">
                    {r.bucket === 'slow' && r.tokPerSecOffloaded !== null && !r.cpuOnly ? (
                      <>
                        <span className="text-studio-muted">{tokS(r.tokPerSec)}</span>
                        <span className="text-studio-subtle"> → </span>
                        <span className="text-studio-text">{tokS(r.tokPerSecOffloaded)}</span>
                      </>
                    ) : (
                      <span className="text-studio-text">{tokS(r.tokPerSec)}</span>
                    )}
                    <span className="text-[10px] text-studio-subtle"> tok/s</span>
                    {r.mtpAcceptedTokens !== null && (
                      <>
                        {' '}
                        <MtpTag accepted={r.mtpAcceptedTokens} />
                      </>
                    )}
                    {r.moe && (
                      <>
                        {' '}
                        <MoeTag />
                      </>
                    )}
                  </span>
                ) : (
                  r.bucket !== 'no' && !p.bandwidthKnown && <span className="text-[10px] text-studio-subtle">tok/s needs bandwidth</span>
                )}
              </div>

              <div className="text-right whitespace-nowrap">
                <span className="figure text-mini text-studio-muted">{gib(r.downloadBytes)}</span>
                {fits === false && (
                  <span className="ml-1.5">
                    <Pill tone="bad" title={`Only ${gib(p.freeDiskBytes!)} free on ${p.diskLabel}`}>
                      no space
                    </Pill>
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <footer className="px-3 py-2 border-t border-studio-border text-[10px] text-studio-subtle flex flex-wrap gap-x-4 gap-y-1">
        {p.rows.some((r) => r.cpuOnly) ? (
          <span>No discrete GPU: every model streams from RAM on the CPU, paced by the RAM bus; a discrete GPU is what changes this. Required = the pulled file + KV cache at this context + reserves, against RAM.</span>
        ) : (
          <span>Required = the pulled file + KV cache at this context + 1.6 GB of reserves; tight below 1.5 GiB of headroom.</span>
        )}
        <span>
          Download sizes vs {p.freeDiskBytes === null ? 'free space unknown' : `${gib(p.freeDiskBytes, 0)} free on ${p.diskLabel}`}
          {p.freeDiskBytes !== null && (
            <>
              {' '}
              <Tag kind="measured" />
            </>
          )}
        </span>
      </footer>
    </section>
  );
};
