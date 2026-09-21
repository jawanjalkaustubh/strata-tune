import React, { useState } from 'react';
import { Download, Play, Square, Trash2, Upload } from 'lucide-react';
import type { BenchyProgress, BenchyStatus, LlmProgress, OllamaInstalled } from '../../api';
import { COLUMNS, TABLE_COLUMNS, atDepth, bestBenchy, bestOf, groupBenchy, groupByModel, machineLabel, type BenchyResult, type LlmBenchResult, type Stat } from '../../analysis/llm-bench';
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
  /** llama-benchy: its rows, whether uvx is here (null while being asked), its last output line while it runs. */
  benchy: BenchyResult[];
  benchyStatus: BenchyStatus | null;
  benchyRunning: BenchyProgress | null;
  onBenchy: (model: string) => void;
  onBenchyStop: () => void;
}

const HEAD = 'label text-studio-subtle font-normal text-left whitespace-nowrap pb-1';
const HEAD_R = `${HEAD} text-right pl-3`;

/** Short heads so nine figures fit a row; the long name is the tooltip. */
const SHORT: Record<string, string> = {
  gen: 'Gen',
  prefill: 'Prefill',
  first: '1st token',
  load: 'Load',
  memory: 'Resident',
  gpuW: 'GPU W',
  systemW: 'System W',
  perGpuW: 'tok/s per GPU W',
  perSystemW: 'tok/s per sys W'
};
const NUM = 'text-right tabular-nums whitespace-nowrap';
const BTN = 'inline-flex items-center gap-1 h-6 px-2 rounded border border-studio-border text-mini hover:bg-studio-panel-hi disabled:opacity-50 disabled:hover:bg-transparent';

const seconds = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} s` : `${Math.round(ms)} ms`);
const watts = (w: number | null) => (w === null ? '—' : `${Math.round(w)} W`);
const perW = (v: number | null) => (v === null ? '—' : v >= 1 ? v.toFixed(2) : v.toFixed(3));
const dash = '—';
const kilo = (n: number) => (n >= 1024 ? `${Math.round(n / 1024)}k` : String(n));

const PHASE: Record<LlmProgress['phase'], string> = {
  evict: 'unloading the model so run 1 loads cold',
  idle: 'reading idle power',
  load: 'loading and generating (run 1: the cold load)',
  run: 'generating',
  done: 'writing the result'
};

/** A figure with its ± beside it, the way llama-benchy prints one; the ± is muted so the figure reads first. */
const PlusMinus: React.FC<{ value: number; std?: number; unit?: string; digits?: (v: number) => string }> = ({ value, std, unit, digits = tokS }) => (
  <>
    {digits(value)}
    {std !== undefined && std > 0 && <span className="text-studio-subtle"> ±{digits(std)}</span>}
    {unit && ` ${unit}`}
  </>
);

const StatCell: React.FC<{ s: Stat | null; digits?: (v: number) => string; win?: boolean; title?: string }> = ({ s, digits = tokS, win, title }) => (
  <td className={`${NUM} py-0.5 pl-3 ${win ? 'text-emerald-400 figure' : 'text-studio-text'}`} title={title}>
    {s ? <PlusMinus value={s.mean} std={s.std} digits={digits} /> : dash}
  </td>
);

/** The host on one line and the GPU under it, so nine figures fit beside them; the full machine in the tooltip. */
const MachineCell: React.FC<{ r: { machine: LlmBenchResult['machine']; imported: boolean }; detail?: string }> = ({ r, detail }) => {
  const m = r.machine;
  const title = `${machineLabel(m)} · ${m.os}${m.cpuName ? ` · ${m.cpuName}` : ''} · ${gib(m.ramBytes, 0)} RAM${m.unified ? ' (unified)' : ` · ${gib(m.vramBytes, 0)} VRAM`}${m.driver ? ` · driver ${m.driver}` : ''}${detail ? `\n${detail}` : ''}`;
  return (
    <span className="inline-flex flex-col leading-tight" title={title}>
      <span className="flex items-center gap-1.5">
        <span className={r.imported ? 'text-studio-muted' : 'text-studio-text'}>{m.hostname}</span>
        {r.imported ? <Tag kind="measured" title="Imported from the other machine's export" /> : <Tag kind="you" title="Measured on this machine" />}
      </span>
      <span className="text-[10px] text-studio-subtle">
        {m.gpuName} · {m.os}
      </span>
    </span>
  );
};

/**
 * Plan section 10c, the comparison that holds across machines: one quantised model, one
 * thousand-token prompt, 256 tokens at temperature 0, three runs at each context depth,
 * Ollama's own counters; the collector's watts and memory beside them. Rows from another
 * machine come in through Import and sit under the same model tag as this one's, best figure
 * per column marked. Under it, llama-benchy's table for the same models: the community
 * numbers, client-timed, comparable with what other people publish.
 */
export const LlmBenchCard: React.FC<Props> = (p) => {
  const [model, setModel] = useState('');
  const busy = p.running !== null || p.benchyRunning !== null;
  const installed = p.installed ?? [];
  const chosen = model || installed[0]?.name || '';
  const groups = groupByModel(p.results);
  const benchyGroups = groupBenchy(p.benchy);
  const ollamaUp = p.available && !p.ollamaAbsent;
  const canRun = ollamaUp && installed.length > 0 && !busy;
  const columns = COLUMNS.filter((c) => TABLE_COLUMNS.includes(c.key) && (c.key !== 'perSystemW' || p.results.some((r) => r.efficiency.tokPerSecPerSystemW !== null)));
  const sweptDepths = [...new Set(p.results.flatMap((r) => (r.depths ?? []).map((d) => d.depth)))].filter((d) => d > 0).sort((a, b) => a - b);
  const uvx = p.benchyStatus?.uvx ?? null;

  return (
    <Card
      title="LLM benchmark"
      aside={
        <span className="flex items-center gap-1.5">
          {ollamaUp && installed.length > 0 && (
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
          {p.running ? (
            <button className={BTN} onClick={p.onStop} title="Stop (Esc)">
              <Square size={11} /> Stop
            </button>
          ) : (
            <button className={BTN} disabled={!canRun} onClick={() => chosen && p.onRun(chosen)} title={canRun ? 'Three runs of the fixed prompt at each context depth (0, 4k, 16k); a few minutes on a large model' : 'Needs Ollama with a model installed'}>
              <Play size={11} /> Run
            </button>
          )}
          {p.benchyRunning ? (
            <button className={BTN} onClick={p.onBenchyStop} title="Stop llama-benchy">
              <Square size={11} /> Stop llama-benchy
            </button>
          ) : (
            <button
              className={BTN}
              disabled={!canRun || !uvx}
              onClick={() => chosen && p.onBenchy(chosen)}
              title={uvx ? `llama-benchy through ${uvx}: pp 1024, tg 256, depths 0, 4k, 16k, three runs; several minutes` : p.benchyStatus ? `Needs uv: ${p.benchyStatus.installHint}` : 'Looking for uvx…'}
            >
              <Play size={11} /> llama-benchy
            </button>
          )}
        </span>
      }
    >
      <p className="text-mini text-studio-muted">
        The same model, the same thousand-token prompt, 256 tokens at temperature 0, three runs at each context depth, timed by Ollama's own counters; the collector's watts and memory read alongside.
        Run it here, press Export, then Import that file on the other machine and the two rows sit together. A PC's advertised TOPS and a Mac's measured matmul never compare; tokens per second on one quantised model do.
      </p>
      {!p.available && <p className="text-mini text-studio-muted">The benchmark needs the app: the plain browser cannot reach Ollama.</p>}
      {p.available && p.ollamaAbsent && <p className="text-mini text-studio-muted">Ollama is not running; start it (Strata Code's top bar, or the Ollama app) and the model list appears here.</p>}
      {ollamaUp && p.installed && installed.length === 0 && <p className="text-mini text-studio-muted">Ollama is running but has no models; pull one to benchmark.</p>}
      {ollamaUp && !p.collectorConnected && <p className="text-mini text-studio-muted">Collector not connected: tokens still time, but the watt and memory columns stay blank.</p>}
      {p.running && (
        <p className="text-mini text-studio-text">
          {p.running.model}: {PHASE[p.running.phase]}
          {p.running.phase === 'run' || p.running.phase === 'load' ? ` (run ${p.running.run} of ${p.running.runs}${p.running.depth > 0 ? ` at ${kilo(p.running.depth)} context` : ''})` : ''}…
        </p>
      )}
      {p.benchyRunning && (
        <p className="text-mini text-studio-text truncate" title={p.benchyRunning.line}>
          llama-benchy on {p.benchyRunning.model}: <span className="text-studio-muted">{p.benchyRunning.line}</span>
        </p>
      )}
      {p.error && <p className="text-mini text-rose-300">{p.error}</p>}
      {p.stopped && !busy && <p className="text-mini text-studio-muted">Stopped; the earlier rows stand.</p>}

      {groups.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-mini border-separate border-spacing-0">
            <thead>
              <tr>
                <th className={HEAD}>Machine</th>
                {columns.map((c) => (
                  <th key={c.key} className={HEAD_R} title={`${c.label}: ${COLUMN_HELP[c.key]}`}>
                    {SHORT[c.key] ?? c.label}
                  </th>
                ))}
                <th className={HEAD_R}>When</th>
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
                    {g.results.map((r) => {
                      const zero = atDepth(r, 0);
                      return (
                        <React.Fragment key={r.id}>
                          <tr className="border-t border-studio-border">
                            <td className="py-1 pr-2 whitespace-nowrap align-top">
                              <MachineCell r={r} />
                            </td>
                            {columns.map((c) => {
                              const v = c.of(r);
                              const win = best[c.key]?.has(r.id);
                              const spread = c.key === 'gen' ? zero?.genStd : c.key === 'prefill' ? zero?.prefillStd : undefined;
                              return (
                                <td key={c.key} className={`${NUM} py-0.5 pl-3 ${win ? 'text-emerald-400 figure' : 'text-studio-text'}`} title={cellTitle(c.key, r)}>
                                  {v === null ? dash : spread !== undefined ? <PlusMinus value={v} std={spread} unit="tok/s" /> : cell(c.key, v)}
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
                          {sweptDepths.some((depth) => atDepth(r, depth)) && (
                            <tr>
                              <td colSpan={columns.length + 3} className="pb-1.5 pl-3 text-[10px] text-studio-muted whitespace-nowrap">
                                {sweptDepths.map((depth) => {
                                  const d = atDepth(r, depth);
                                  if (!d) return null;
                                  const genWin = best[depth === 4096 ? 'gen4k' : 'gen16k']?.has(r.id);
                                  const ppWin = best[depth === 4096 ? 'pp4k' : 'pp16k']?.has(r.id);
                                  return (
                                    <span key={depth} className="mr-5" title={`${d.promptTokens} prompt tokens behind ${kilo(depth)} of context; ${d.runs.length} runs`}>
                                      <span className="text-studio-subtle">behind {kilo(depth)} of context:</span>{' '}
                                      <span className={genWin ? 'text-emerald-400 figure' : 'text-studio-text'}>
                                        <PlusMinus value={d.genTokPerSec} std={d.genStd} />
                                      </span>
                                      {' gen · '}
                                      <span className={ppWin ? 'text-emerald-400 figure' : 'text-studio-text'}>
                                        <PlusMinus value={d.prefillTokPerSec} std={d.prefillStd} />
                                      </span>
                                      {' prefill · first token '}
                                      {seconds(d.firstTokenMs)}
                                    </span>
                                  );
                                })}
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {benchyGroups.length > 0 && (
        <div className="pt-2">
          <p className="label text-studio-subtle">llama-benchy</p>
          <p className="text-[10px] text-studio-subtle">
            eugr/llama-benchy against Ollama's OpenAI endpoint, timed on the client with its generation-latency correction: the table people publish, so these rows compare with theirs. pp 1024 · tg 256 · three runs; a depth beyond Ollama's window on that machine is skipped.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-mini border-separate border-spacing-0">
              <thead>
                <tr>
                  <th className={HEAD}>Machine</th>
                  <th className={`${HEAD} pl-3`}>Test</th>
                  <th className={HEAD_R} title="Prompt processing tok/s: prompt tokens / (time to first response − measured latency)">pp t/s</th>
                  <th className={HEAD_R} title="Decode tok/s: tokens after the first / their interval">tg t/s</th>
                  <th className={HEAD_R} title="The best one-second window of decode">peak t/s</th>
                  <th className={HEAD_R} title="Time to first response chunk, network included (ms)">ttfr ms</th>
                  <th className={HEAD_R} title="Estimated prompt processing time: ttfr minus the measured latency (ms)">est_ppt ms</th>
                  <th className={HEAD_R} title="End-to-end time to the first content token (ms)">e2e_ttft ms</th>
                  <th className={HEAD_R}>When</th>
                  <th className={HEAD} />
                </tr>
              </thead>
              <tbody>
                {benchyGroups.map((g) => {
                  const best = bestBenchy(g.results);
                  return (
                    <React.Fragment key={g.model}>
                      <tr>
                        <td colSpan={10} className="pt-2 pb-0.5">
                          <span className="figure text-studio-text">{g.model}</span>
                        </td>
                      </tr>
                      {g.results.map((r) =>
                        g.contexts.map((ctx, i) => {
                          const row = r.rows.find((x) => x.contextSize === ctx);
                          const label = row ? `pp${row.promptSize} / tg${row.responseSize}${ctx > 0 ? ` @ d${ctx}` : ''}` : `@ d${ctx}`;
                          return (
                            <tr key={`${r.id}-${ctx}`} className={i === 0 ? 'border-t border-studio-border' : ''}>
                              <td className="py-0.5 pr-2 whitespace-nowrap align-top">
                                {i === 0 && <MachineCell r={r} detail={`llama-benchy ${r.version}, latency ${r.latencyMode}${r.latencyMs !== null ? ` ${r.latencyMs.toFixed(0)} ms` : ''}${r.contextLength !== null ? ` · Ollama window ${kilo(r.contextLength)}` : ''}\n${r.args}`} />}
                              </td>
                              <td className="py-0.5 pl-3 whitespace-nowrap text-studio-muted" title={row ? undefined : `Skipped: ${kilo(ctx)} of context does not fit Ollama's window on this machine`}>
                                {label}
                              </td>
                              <StatCell s={row?.pp ?? null} win={best[`pp@${ctx}`]?.has(r.id)} />
                              <StatCell s={row?.tg ?? null} win={best[`tg@${ctx}`]?.has(r.id)} />
                              <StatCell s={row?.peak ?? null} />
                              <StatCell s={row?.ttfrMs ?? null} digits={(v) => v.toFixed(0)} title="ms" />
                              <StatCell s={row?.estPptMs ?? null} digits={(v) => v.toFixed(0)} title="ms" />
                              <StatCell s={row?.e2eTtftMs ?? null} digits={(v) => v.toFixed(0)} title="ms" />
                              <td className={`${NUM} py-0.5 pl-3 text-studio-muted`}>{i === 0 ? new Date(r.measuredAt).toLocaleDateString() : ''}</td>
                              <td className="py-0.5 pl-2 text-right">
                                {i === 0 && (
                                  <button className="text-studio-subtle hover:text-rose-300" title="Remove this llama-benchy run" onClick={() => p.onDelete(r.id)} disabled={busy}>
                                    <Trash2 size={11} />
                                  </button>
                                )}
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        <button className={BTN} disabled={(p.results.length === 0 && p.benchy.length === 0) || busy} onClick={p.onExport} title="Write every row, ours and llama-benchy's, to a JSON file for the other machine's Import">
          <Download size={11} /> Export
        </button>
        <button className={BTN} disabled={!p.available || busy} onClick={p.onImport} title="Read a file written by Export on another machine">
          <Upload size={11} /> Import
        </button>
        {p.notice && <span className="text-mini text-studio-muted truncate">{p.notice}</span>}
      </div>
      {ollamaUp && p.benchyStatus && !uvx && (
        <p className="text-[10px] text-studio-subtle">
          llama-benchy needs uv. Install it with <code className="figure">{p.benchyStatus.installHint}</code>, then relaunch Strata Tune.
        </p>
      )}
      {p.results.length > 0 && (
        <p className="text-[10px] text-studio-subtle">
          GPU power is the board figure on a PC (NVML) and the GPU core on Apple Silicon; system power is the SMC's whole-machine reading, which a PC has no sensor for. Resident is Ollama's own figure for the model in GPU memory: VRAM on a PC, the unified pool on a Mac. ± is the sample spread over the runs.
        </p>
      )}
    </Card>
  );
};

const COLUMN_HELP: Record<string, string> = {
  gen: 'Tokens per second while generating (Ollama eval_count / eval_duration), median ± spread of the runs at zero depth',
  prefill: 'Prompt tokens per second (prompt_eval_count / prompt_eval_duration), median ± spread of the runs at zero depth',
  first: 'Time to the first token once the model is resident: the prompt evaluation, median of the runs',
  load: 'Run 1 loads the model from nothing (it is evicted first): Ollama\'s load_duration',
  memory: 'What Ollama holds resident for the model after the run (/api/ps): VRAM on a PC, the unified pool on a Mac',
  gpuW: 'Mean GPU power while a generation was in flight, every depth included; the peak is in the tooltip',
  systemW: 'Mean whole-machine power while a generation was in flight (Apple SMC); a PC has no such sensor',
  perGpuW: 'Generation tokens per second per mean GPU watt: what the GPU pays for its speed',
  perSystemW: 'Generation tokens per second per mean system watt'
};

function cell(key: string, v: number): string {
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
