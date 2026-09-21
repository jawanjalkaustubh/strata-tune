import React, { useState } from 'react';
import { Download, Play, Square, Trash2, Upload } from 'lucide-react';
import type { LlmProgress, OllamaInstalled } from '../../api';
import { COLUMNS, bestOf, groupByModel, machineLabel, type LlmBenchResult } from '../../analysis/llm-bench';
import { Card } from './Card';
import { Tag } from './Tag';
import { gib, tokS } from './format';

interface Props {
  installed: OllamaInstalled[] | null;
  /** Ollama reachable through the app; the plain browser has no bridge to it. */
  available: boolean;
  ollamaAbsent: boolean;
  /** Without the collector the run still times tokens; the watt and memory columns stay blank. */
  collectorConnected: boolean;
  results: LlmBenchResult[];
  running: LlmProgress | null;
  error: string;
  /** The last run was stopped: one muted line, earlier rows standing. */
  stopped: boolean;
  /** The last Export's path or Import's count, said once under the buttons. */
  notice: string;
  onRun: (model: string) => void;
  onStop: () => void;
  onDelete: (id: string) => void;
  onExport: () => void;
  onImport: () => void;
}

const HEAD = 'label text-studio-subtle font-normal text-left whitespace-nowrap';
const NUM = 'text-right tabular-nums whitespace-nowrap';
const BTN = 'inline-flex items-center gap-1 h-6 px-2 rounded border border-studio-border text-mini hover:bg-studio-panel-hi disabled:opacity-50 disabled:hover:bg-transparent';

const seconds = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} s` : `${Math.round(ms)} ms`);
const watts = (w: number | null) => (w === null ? '—' : `${Math.round(w)} W`);
const perW = (v: number | null) => (v === null ? '—' : v >= 1 ? v.toFixed(2) : v.toFixed(3));
const dash = '—';

const PHASE: Record<LlmProgress['phase'], string> = {
  evict: 'unloading the model so run 1 loads cold',
  idle: 'reading idle power',
  load: 'loading and generating (run 1: the cold load)',
  run: 'generating',
  done: 'writing the result'
};

/**
 * Plan section 10, the comparison that holds across machines: one quantised model, one
 * thousand-token prompt, 256 tokens at temperature 0, three runs, Ollama's own counters;
 * the collector's watts and memory beside them. Rows from another machine come in through
 * Import and sit under the same model tag as this one's, best figure per column marked.
 */
export const LlmBenchCard: React.FC<Props> = (p) => {
  const [model, setModel] = useState('');
  const busy = p.running !== null;
  const installed = p.installed ?? [];
  const chosen = model || installed[0]?.name || '';
  const groups = groupByModel(p.results);
  const canRun = p.available && !p.ollamaAbsent && installed.length > 0 && !busy;
  const columns = COLUMNS.filter((c) => c.key !== 'perSystemW' || p.results.some((r) => r.efficiency.tokPerSecPerSystemW !== null));

  return (
    <Card
      title="LLM benchmark"
      aside={
        <span className="flex items-center gap-1.5">
          {p.available && !p.ollamaAbsent && installed.length > 0 && (
            <select
              className="h-6 rounded border border-studio-border bg-studio-panel text-mini px-1 max-w-[16rem]"
              value={chosen}
              disabled={busy}
              onChange={(e) => setModel(e.target.value)}
              title="The model to time; run the same tag on the other machine"
            >
              {installed.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name}
                  {m.parameterSize ? ` · ${m.parameterSize}` : ''}
                  {m.quantization ? ` ${m.quantization}` : ''}
                </option>
              ))}
            </select>
          )}
          {busy ? (
            <button className={BTN} onClick={p.onStop} title="Stop (Esc)">
              <Square size={11} /> Stop
            </button>
          ) : (
            <button className={BTN} disabled={!canRun} onClick={() => chosen && p.onRun(chosen)} title={canRun ? 'Three runs of the fixed prompt; about a minute on a small model, longer on a large one' : 'Needs Ollama with a model installed'}>
              <Play size={11} /> Run
            </button>
          )}
        </span>
      }
    >
      <p className="text-mini text-studio-muted">
        The same model, the same thousand-token prompt, 256 tokens at temperature 0, three runs, timed by Ollama's own counters; the collector's watts and memory read alongside.
        Run it here, press Export, then Import that file on the other machine and the two rows sit together. A PC's advertised TOPS and a Mac's measured matmul never compare; tokens per second on one quantised model do.
      </p>
      {!p.available && <p className="text-mini text-studio-muted">The benchmark needs the app: the plain browser cannot reach Ollama.</p>}
      {p.available && p.ollamaAbsent && <p className="text-mini text-studio-muted">Ollama is not running; start it (Strata Code's top bar, or the Ollama app) and the model list appears here.</p>}
      {p.available && !p.ollamaAbsent && p.installed && installed.length === 0 && <p className="text-mini text-studio-muted">Ollama is running but has no models; pull one to benchmark.</p>}
      {p.available && !p.ollamaAbsent && !p.collectorConnected && <p className="text-mini text-studio-muted">Collector not connected: tokens still time, but the watt and memory columns stay blank.</p>}
      {p.running && (
        <p className="text-mini text-studio-text">
          {p.running.model}: {PHASE[p.running.phase]}
          {p.running.phase === 'run' || p.running.phase === 'load' ? ` (run ${p.running.run} of ${p.running.runs})` : ''}…
        </p>
      )}
      {p.error && <p className="text-mini text-rose-300">{p.error}</p>}
      {p.stopped && !p.running && <p className="text-mini text-studio-muted">Stopped; the earlier rows stand.</p>}

      {groups.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-mini border-separate border-spacing-0">
            <thead>
              <tr>
                <th className={HEAD}>Machine</th>
                {columns.map((c) => (
                  <th key={c.key} className={`${HEAD} text-right`} title={COLUMN_HELP[c.key]}>
                    {c.label}
                  </th>
                ))}
                <th className={`${HEAD} text-right`}>When</th>
                <th className={HEAD} />
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                const best = bestOf(g.results);
                const first = g.results[0];
                return (
                  <React.Fragment key={g.model}>
                    <tr>
                      <td colSpan={columns.length + 3} className="pt-2 pb-0.5">
                        <span className="figure text-studio-text">{g.model}</span>
                        <span className="text-studio-muted">
                          {first.model.parameterSize ? ` · ${first.model.parameterSize}` : ''}
                          {first.model.quantization ? ` · ${first.model.quantization}` : ''}
                          {first.model.sizeBytes ? ` · ${gib(first.model.sizeBytes)} on disk` : ''}
                        </span>
                      </td>
                    </tr>
                    {g.results.map((r) => (
                      <tr key={r.id} className="border-t border-studio-border">
                        <td className="py-0.5 pr-2 whitespace-nowrap">
                          <span className={r.imported ? 'text-studio-muted' : 'text-studio-text'} title={`${r.machine.os}${r.machine.cpuName ? ` · ${r.machine.cpuName}` : ''} · ${gib(r.machine.ramBytes, 0)} RAM${r.machine.unified ? ' (unified)' : ` · ${gib(r.machine.vramBytes, 0)} VRAM`}${r.machine.driver ? ` · driver ${r.machine.driver}` : ''}`}>
                            {machineLabel(r.machine)}
                          </span>{' '}
                          <span className="text-[10px] text-studio-subtle">{r.machine.os}</span>{' '}
                          {r.imported ? <Tag kind="measured" title="Imported from the other machine's export" /> : <Tag kind="you" title="Measured on this machine" />}
                        </td>
                        {columns.map((c) => {
                          const v = c.of(r);
                          const win = best[c.key]?.has(r.id);
                          return (
                            <td key={c.key} className={`${NUM} py-0.5 pl-3 ${win ? 'text-emerald-400 figure' : 'text-studio-text'}`} title={cellTitle(c.key, r)}>
                              {cell(c.key, v)}
                            </td>
                          );
                        })}
                        <td className={`${NUM} py-0.5 pl-3 text-studio-muted`}>{new Date(r.measuredAt).toLocaleDateString()}</td>
                        <td className="py-0.5 pl-2 text-right">
                          <button className="text-studio-subtle hover:text-rose-300" title="Remove this row" onClick={() => p.onDelete(r.id)} disabled={busy}>
                            <Trash2 size={11} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        <button className={BTN} disabled={p.results.length === 0 || busy} onClick={p.onExport} title="Write every row to a JSON file for the other machine's Import">
          <Download size={11} /> Export
        </button>
        <button className={BTN} disabled={!p.available || busy} onClick={p.onImport} title="Read a file written by Export on another machine">
          <Upload size={11} /> Import
        </button>
        {p.notice && <span className="text-mini text-studio-muted truncate">{p.notice}</span>}
      </div>
      {p.results.length > 0 && (
        <p className="text-[10px] text-studio-subtle">
          GPU power is the board figure on a PC (NVML) and the GPU core on Apple Silicon; system power is the SMC's whole-machine reading, which a PC has no sensor for. Model in memory is Ollama's own resident figure, which on a Mac comes out of the unified pool.
        </p>
      )}
    </Card>
  );
};

const COLUMN_HELP: Record<string, string> = {
  gen: 'Tokens per second while generating (Ollama eval_count / eval_duration), median of the runs',
  prefill: 'Prompt tokens per second (prompt_eval_count / prompt_eval_duration), median of the runs',
  first: 'Time to the first token once the model is resident: the prompt evaluation, median of the runs',
  load: 'Run 1 loads the model from nothing (it is evicted first): Ollama\'s load_duration',
  memory: 'What Ollama holds in GPU memory for the model after the run (/api/ps)',
  gpuW: 'Mean GPU power while a generation was in flight; the peak is in the tooltip',
  systemW: 'Mean whole-machine power while a generation was in flight (Apple SMC); a PC has no such sensor',
  perGpuW: 'Generation tokens per second per mean GPU watt: what the GPU pays for its speed',
  perSystemW: 'Generation tokens per second per mean system watt'
};

function cell(key: string, v: number | null): string {
  if (v === null) return dash;
  switch (key) {
    case 'gen':
    case 'prefill':
      return `${tokS(v)} tok/s`;
    case 'first':
    case 'load':
      return seconds(v);
    case 'memory':
      return gib(v);
    case 'gpuW':
    case 'systemW':
      return watts(v);
    default:
      return perW(v);
  }
}

function cellTitle(key: string, r: LlmBenchResult): string | undefined {
  switch (key) {
    case 'gen':
      return `Runs: ${r.runs.map((x) => tokS(x.evalCount / (x.evalMs / 1000))).join(', ')} tok/s over ${r.settings.predictTokens} tokens`;
    case 'prefill':
      return `${r.settings.promptTokens} prompt tokens; runs: ${r.runs.map((x) => (x.promptEvalMs > 0 ? tokS(x.promptEvalCount / (x.promptEvalMs / 1000)) : '?')).join(', ')} tok/s`;
    case 'gpuW':
      return r.power.gpuAvgW === null ? undefined : `Idle ${watts(r.power.gpuIdleW)}, peak ${watts(r.power.gpuPeakW)}${r.power.cpuAvgW !== null ? `; CPU package ${watts(r.power.cpuAvgW)} mean` : ''}`;
    case 'systemW':
      return r.power.systemAvgW === null ? undefined : `Idle ${watts(r.power.systemIdleW)}, peak ${watts(r.power.systemPeakW)}`;
    case 'memory':
      return r.memory.gpuUsedPeakMiB === null ? undefined : `GPU memory in use peaked at ${gib(r.memory.gpuUsedPeakMiB * 1024 ** 2)}${r.memory.gpuUsedIdleMiB !== null ? ` from ${gib(r.memory.gpuUsedIdleMiB * 1024 ** 2)} idle` : ''}`;
    default:
      return undefined;
  }
}
