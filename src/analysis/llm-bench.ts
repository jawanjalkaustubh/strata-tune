/**
 * The LLM benchmark (plan section 10, the cross-machine comparison): the same model, the
 * same prompt, the same sampling and the same length on every machine, timed by Ollama's
 * own counters (prompt_eval and eval duration, load duration) the way a `--verbose` run
 * prints them, with the collector's power and memory readings sampled alongside. A PC's
 * advertised TOPS and a Mac's measured matmul never compare; tokens per second on one
 * quantised model do, and tokens per second per watt say what each machine pays for them.
 *
 * Pure: the Electron runner (electron/llm-bench.ts) and the card both import from here.
 */

export const LLM_PROTOCOL = 'strata-llm-1';
export const PREDICT_TOKENS = 256;
export const NUM_CTX = 4096;
export const DEFAULT_RUNS = 3;
export const SEED = 7;
/** How often the collector is read while a generation runs, and for how long the idle baseline is read before it. */
export const SAMPLE_MS = 250;
export const IDLE_SECONDS = 2;

/**
 * About a thousand tokens, the same text on every machine so the prefill figure means the
 * same thing: a long enough prompt that prompt evaluation runs for a measurable time on a
 * 5090, where sixty tokens finish before the clock settles. Plain prose with no instruction
 * the model could refuse or answer briefly.
 */
export const PROMPT_BODY =
  'Continue the following account in plain prose, in the same voice, for about three hundred words; no headings, lists or questions, and do not stop early.\n\n' +
  'The observatory stood on the last ridge before the plateau fell away into the salt flats, and for the first decade of its life nobody who worked there had ever seen it rain. ' +
  'The engineers who built it had chosen the site for exactly that reason: the air above the ridge was thin and dry and still, and on most nights the stars did not so much shine as hang, ' +
  'steady and unblinking, close enough that the older astronomers claimed they could feel the cold coming off them. The dome itself was a plain thing, a ribbed aluminium shell painted white ' +
  'to throw back the daytime heat, and inside it the mirror sat in its cell like a held breath, eight metres of glass polished to a surface so precise that the whole machine had been built ' +
  'around the problem of never touching it. Every evening the shutters opened with a sound like a slow exhalation, and the dome turned to follow whatever field the night\'s programme called for, ' +
  'and the people who ran it settled into the long routine of waiting.\n\n' +
  'Most of the work was waiting. The instruments gathered light in exposures that lasted minutes or hours, and during those hours there was little to do but watch the guide star hold its ' +
  'position on the screen and listen to the drives hum. The night assistants drank tea from a battered urn in the control room and kept the logs, and the visiting scientists, who had flown in ' +
  'from cities with weather and traffic and rain, learned within a night or two to stop asking whether anything had happened yet. Something was always happening; it was just happening at a ' +
  'rate that had nothing to do with the clocks on the wall. Photons that had left their sources before the ridge itself was lifted out of the sea arrived a few at a time, were counted, and were ' +
  'written to disk, and the disk filled slowly, and in the morning somebody copied it to the archive and the whole thing began again.\n\n' +
  'The archive was the observatory\'s true product, though few of the people who worked there thought of it that way. It lived in a low concrete building at the bottom of the access road, ' +
  'air-conditioned and windowless, and it held every frame the telescope had ever taken, indexed by date and target and instrument, along with the weather logs, the seeing measurements, the ' +
  'calibration frames and the terse notes the night assistants had left about clouds and cables and the one time a fox had got into the dome. Astronomers who had never visited the ridge could ' +
  'request any of it, and did, and the archive answered their queries in the same unhurried way the telescope answered the sky. Papers were written from it that its original observers would not ' +
  'have recognised as theirs, about objects nobody had been looking for, found later in the corners of fields pointed somewhere else entirely.\n\n' +
  'The maintenance crew came up the road on Tuesdays. They were three people and a truck, and they knew the building better than anyone who used it, because they were the ones who crawled ' +
  'through its cable trays and replaced its pumps and re-seated the boards that the dry air and the altitude wore out faster than the manufacturers had ever expected. They kept a list of ' +
  'everything that had ever broken, and the list was long, and it told a story about the building that the archive did not: a story of fatigue and dust and the slow settling of a large ' +
  'machine into a place that had not been designed for it. The mirror, which everyone worried about, had never given any trouble at all. It was the small things that failed, the fans and the ' +
  'relays and the tired seals, and the crew replaced them one by one, and wrote them down, and drove back down the road before dark.\n\n' +
  'On the night the weather changed, the first sign was';

/** The run's own prefix keeps Ollama from answering the prefill from its cached prefix: a different first token, a full prompt evaluation every time. */
export const promptForRun = (run: number, runs: number) => `Benchmark run ${run} of ${runs}.\n\n${PROMPT_BODY}`;

export interface LlmRun {
  /** Ollama's counters for the run. */
  promptEvalCount: number;
  promptEvalMs: number;
  evalCount: number;
  evalMs: number;
  loadMs: number;
  totalMs: number;
}

export interface LlmSample {
  gpuW: number | null;
  cpuW: number | null;
  systemW: number | null;
  gpuMemMiB: number | null;
}

export interface LlmMachine {
  hostname: string;
  os: 'macOS' | 'Windows' | 'Linux';
  gpuName: string;
  cpuName: string | null;
  ramBytes: number;
  vramBytes: number;
  /** One memory pool (Apple Silicon): the model's resident bytes come out of the same RAM. */
  unified: boolean;
  driver: string | null;
}

export interface LlmModel {
  name: string;
  parameterSize: string;
  quantization: string;
  family: string;
  sizeBytes: number;
}

export interface LlmBenchResult {
  id: string;
  protocol: typeof LLM_PROTOCOL;
  measuredAt: string;
  machine: LlmMachine;
  model: LlmModel;
  settings: { promptTokens: number; predictTokens: number; numCtx: number; runs: number };
  /** Run 1 loads the model from nothing (it is evicted first): the load figure the host watches in Ollama's verbose output. */
  loadMs: number;
  /** Medians over the runs. */
  prefillTokPerSec: number;
  genTokPerSec: number;
  /** Median prompt evaluation time: the wait before the first token once the model is resident. */
  firstTokenMs: number;
  runs: LlmRun[];
  memory: {
    /** Ollama's own figure for the model in GPU memory after the run (/api/ps size_vram); null when it was not listed. */
    residentBytes: number | null;
    gpuUsedIdleMiB: number | null;
    gpuUsedPeakMiB: number | null;
  };
  power: {
    gpuIdleW: number | null;
    gpuAvgW: number | null;
    gpuPeakW: number | null;
    cpuAvgW: number | null;
    systemIdleW: number | null;
    systemAvgW: number | null;
    systemPeakW: number | null;
  };
  /** Generation tokens per second per average GPU watt, and per system watt where the machine reports one. */
  efficiency: { tokPerSecPerGpuW: number | null; tokPerSecPerSystemW: number | null };
  /** Came in through Import: another machine's result, kept beside this one's. */
  imported: boolean;
}

export const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 0) return 0;
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const max = (xs: number[]): number | null => (xs.length ? Math.max(...xs) : null);
const pick = (samples: LlmSample[], key: keyof LlmSample): number[] => samples.map((s) => s[key]).filter((v): v is number => v !== null && Number.isFinite(v));

const perSec = (count: number, ms: number) => (count > 0 && ms > 0 ? count / (ms / 1000) : 0);

/**
 * Folds the runs and the sampled readings into one result. `idle` is what the collector read
 * before the model was loaded; `busy` every reading while a generation was in flight.
 */
export function summarise(
  input: { id: string; measuredAt: string; machine: LlmMachine; model: LlmModel; runs: LlmRun[]; idle: LlmSample[]; busy: LlmSample[]; residentBytes: number | null; numCtx?: number; predictTokens?: number }
): LlmBenchResult {
  const runs = input.runs;
  const gpuAvgW = mean(pick(input.busy, 'gpuW'));
  const systemAvgW = mean(pick(input.busy, 'systemW'));
  const gen = median(runs.map((r) => perSec(r.evalCount, r.evalMs)));
  return {
    id: input.id,
    protocol: LLM_PROTOCOL,
    measuredAt: input.measuredAt,
    machine: input.machine,
    model: input.model,
    settings: { promptTokens: Math.round(median(runs.map((r) => r.promptEvalCount))), predictTokens: input.predictTokens ?? PREDICT_TOKENS, numCtx: input.numCtx ?? NUM_CTX, runs: runs.length },
    loadMs: runs[0]?.loadMs ?? 0,
    prefillTokPerSec: median(runs.map((r) => perSec(r.promptEvalCount, r.promptEvalMs))),
    genTokPerSec: gen,
    firstTokenMs: median(runs.map((r) => r.promptEvalMs)),
    runs,
    memory: { residentBytes: input.residentBytes, gpuUsedIdleMiB: mean(pick(input.idle, 'gpuMemMiB')), gpuUsedPeakMiB: max(pick(input.busy, 'gpuMemMiB')) },
    power: {
      gpuIdleW: mean(pick(input.idle, 'gpuW')),
      gpuAvgW,
      gpuPeakW: max(pick(input.busy, 'gpuW')),
      cpuAvgW: mean(pick(input.busy, 'cpuW')),
      systemIdleW: mean(pick(input.idle, 'systemW')),
      systemAvgW,
      systemPeakW: max(pick(input.busy, 'systemW'))
    },
    efficiency: { tokPerSecPerGpuW: gpuAvgW ? gen / gpuAvgW : null, tokPerSecPerSystemW: systemAvgW ? gen / systemAvgW : null },
    imported: false
  };
}

/** The export file: one protocol tag, then results; anything else is refused on import. */
export interface LlmBenchFile {
  strataLlmBench: 1;
  exportedAt: string;
  results: LlmBenchResult[];
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isNumOrNull = (v: unknown): v is number | null => v === null || isNum(v);

/** A result parsed from a file, or from llm-bench.json, that the card can render; anything missing a figure it would show is dropped. */
export function validResult(v: unknown): v is LlmBenchResult {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  const machine = r.machine as Record<string, unknown> | undefined;
  const model = r.model as Record<string, unknown> | undefined;
  const memory = r.memory as Record<string, unknown> | undefined;
  const power = r.power as Record<string, unknown> | undefined;
  return (
    typeof r.id === 'string' &&
    r.protocol === LLM_PROTOCOL &&
    typeof r.measuredAt === 'string' &&
    !!machine && typeof machine.hostname === 'string' && typeof machine.gpuName === 'string' && typeof machine.os === 'string' &&
    !!model && typeof model.name === 'string' && isNum(model.sizeBytes) &&
    isNum(r.loadMs) && isNum(r.prefillTokPerSec) && isNum(r.genTokPerSec) && isNum(r.firstTokenMs) &&
    Array.isArray(r.runs) &&
    !!memory && isNumOrNull(memory.residentBytes) &&
    !!power && isNumOrNull(power.gpuAvgW) && isNumOrNull(power.systemAvgW)
  );
}

/** Reads an export file's text; the error names what was wrong rather than throwing. */
export function parseBenchFile(text: string): { results: LlmBenchResult[] } | { error: string } {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return { error: 'Not a JSON file' };
  }
  const f = j as Partial<LlmBenchFile>;
  if (f?.strataLlmBench !== 1 || !Array.isArray(f.results)) return { error: 'Not a Strata Tune LLM benchmark export' };
  const results = f.results.filter(validResult);
  if (results.length === 0) return { error: 'The file holds no readable result' };
  return { results: results.map((r) => ({ ...r, imported: true })) };
}

/** Results grouped by model tag, the newest first within a group, so a PC row and a Mac row on the same model sit together. */
export function groupByModel(results: LlmBenchResult[]): { model: string; results: LlmBenchResult[] }[] {
  const byModel = new Map<string, LlmBenchResult[]>();
  for (const r of results) {
    const list = byModel.get(r.model.name) ?? [];
    list.push(r);
    byModel.set(r.model.name, list);
  }
  return [...byModel.entries()]
    .map(([model, list]) => ({ model, results: [...list].sort((a, b) => b.measuredAt.localeCompare(a.measuredAt)) }))
    .sort((a, b) => a.model.localeCompare(b.model));
}

/** The columns the comparison ranks; `higher` says which way is better. */
export const COLUMNS: { key: string; label: string; higher: boolean; of: (r: LlmBenchResult) => number | null }[] = [
  { key: 'gen', label: 'Generation', higher: true, of: (r) => r.genTokPerSec },
  { key: 'prefill', label: 'Prefill', higher: true, of: (r) => r.prefillTokPerSec },
  { key: 'first', label: 'First token', higher: false, of: (r) => r.firstTokenMs },
  { key: 'load', label: 'Load', higher: false, of: (r) => r.loadMs },
  { key: 'memory', label: 'Model in memory', higher: false, of: (r) => r.memory.residentBytes },
  { key: 'gpuW', label: 'GPU power', higher: false, of: (r) => r.power.gpuAvgW },
  { key: 'systemW', label: 'System power', higher: false, of: (r) => r.power.systemAvgW },
  { key: 'perGpuW', label: 'tok/s per GPU W', higher: true, of: (r) => r.efficiency.tokPerSecPerGpuW },
  { key: 'perSystemW', label: 'tok/s per system W', higher: true, of: (r) => r.efficiency.tokPerSecPerSystemW }
];

/** Which result wins each column within a group; a column no result reports has no winner. Ties give every tied row the mark. */
export function bestOf(results: LlmBenchResult[]): Record<string, Set<string>> {
  const best: Record<string, Set<string>> = {};
  for (const col of COLUMNS) {
    const values = results.map((r) => [r.id, col.of(r)] as const).filter((x): x is readonly [string, number] => x[1] !== null);
    if (values.length < 2) continue;
    const target = col.higher ? Math.max(...values.map((v) => v[1])) : Math.min(...values.map((v) => v[1]));
    best[col.key] = new Set(values.filter((v) => v[1] === target).map((v) => v[0]));
  }
  return best;
}

/** A one-line label for a result's machine: the host, then the GPU. */
export const machineLabel = (m: LlmMachine) => `${m.hostname} · ${m.gpuName}`;
