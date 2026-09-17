import type { CauseShare, StutterCase, StutterReport } from './report-types';

/**
 * The plain words for each §11 signature. One paragraph says what the rule saw and
 * nothing it did not (the specifics of each event travel in the detail line), one
 * says what to do; cases 7 and 8 are the engine's and get the plan's exact sentence
 * instead of advice. The analysis names the case, this file names the cause.
 */
export interface CauseText {
  case: StutterCase;
  name: string;
  /** The name inside a sentence: lower case, with the acronyms kept. */
  inSentence: string;
  /** What the timeline showed, written for someone who has never opened a BIOS. */
  paragraph: string;
  /** 'Wait' when the fix is to let it pass; 'Verdict' for the engine's cases. */
  label: 'Do' | 'Wait' | 'Verdict';
  action: string;
  /** False for the two engine cases: nothing on this machine changes them. */
  fixable: boolean;
}

export const ENGINE_SENTENCE = 'No setting on your end changes this.';
/** The same call on one signal: honest about how sure the rule is. */
export const ENGINE_SENTENCE_HEDGED = 'Probably nothing on your end changes this — one signal only.';

const CAUSES: CauseText[] = [
  {
    case: 1,
    name: 'Shader compilation',
    inSentence: 'shader compilation',
    paragraph: 'Temporary: the game is compiling shaders the first time it meets new effects and caching them. The hitches came early and thinned out as the capture went on, which is the tell; this settles within a session.',
    label: 'Wait',
    action: 'It plays out. The second time through the same areas it is gone, and it comes back once after a driver or game update clears the cache.',
    fixable: true
  },
  {
    case: 2,
    name: 'Thermal throttle',
    inSentence: 'thermal throttling',
    paragraph: 'The GPU clock dropped while the driver flagged a thermal slowdown, or with the card at its temperature target. The card was protecting itself from heat.',
    label: 'Do',
    action: 'Raise the fan curve, or give the case more airflow; a dusty intake filter or a radiator fed with warm air is the usual reason.',
    fixable: true
  },
  {
    case: 3,
    name: 'Power limit',
    inSentence: 'the power limit',
    paragraph: 'The GPU clock dropped with the power-cap flag set and temperatures normal: the card hit its power limit and slowed down to stay under it.',
    label: 'Do',
    action: 'Raise the power limit in the vendor tool, or undervolt so the card does the same work under the cap.',
    fixable: true
  },
  {
    case: 4,
    name: 'VRAM exhaustion',
    inSentence: 'VRAM exhaustion',
    paragraph: 'Video memory was at least 95 % full when these frames ran, and it was still filling or the GPU ran long on them. When VRAM is full the driver pages textures over PCIe, which is far slower.',
    label: 'Do',
    action: 'Lower the texture quality one step, or the resolution. The average frame rate barely moves; the spikes go.',
    fixable: true
  },
  {
    case: 5,
    name: 'Storage',
    inSentence: 'storage',
    paragraph: 'The disk queue spiked on the same frames: the game was waiting for the drive.',
    label: 'Do',
    action: 'Move the game to an SSD, or free up space on the drive it is on.',
    fixable: true
  },
  {
    case: 6,
    name: 'Background process',
    inSentence: 'a background process',
    paragraph: 'Another program held at least a full core of CPU while the game ran, and the CPU side of these frames stretched.',
    label: 'Do',
    action: 'Close it before playing. The process is named below.',
    fixable: true
  },
  {
    case: 7,
    name: 'Engine tick',
    inSentence: "the engine's tick",
    paragraph: 'The stutters arrived on a fixed beat, independent of what was on screen: the engine’s garbage collector or its streaming tick.',
    label: 'Verdict',
    action: ENGINE_SENTENCE,
    fixable: false
  },
  {
    case: 8,
    name: 'Engine stall',
    inSentence: 'an engine stall',
    paragraph: 'The CPU side ran long on these frames while GPU work stayed normal or the GPU sat waiting, with no sensor moving. The game’s own code stalled.',
    label: 'Verdict',
    action: ENGINE_SENTENCE,
    fixable: false
  },
  {
    case: 9,
    name: 'Pacing',
    inSentence: 'pacing',
    paragraph: 'Long and short frames alternated with no resource behind them: the frame-rate limiter, vsync or frame generation working against each other.',
    label: 'Do',
    action: 'Cap the frame rate a few fps under the refresh rate, and check that vsync and frame generation are not both on.',
    fixable: true
  },
  {
    case: 0,
    name: 'Unexplained',
    inSentence: 'unexplained',
    paragraph: 'Nothing on the timeline lined up with these frames.',
    label: 'Do',
    action: 'Capture the same scene again; a pattern that repeats will say more.',
    fixable: true
  }
];

const BY_CASE = new Map(CAUSES.map((c) => [c.case, c]));

export function causeText(c: StutterCase): CauseText {
  return BY_CASE.get(c) ?? BY_CASE.get(0)!;
}

/** The engine sentence for a cause row, hedged when the rule had one signal. */
export function engineSentence(c: CauseShare): string {
  return c.confidence === 'high' ? ENGINE_SENTENCE : ENGINE_SENTENCE_HEDGED;
}

/** Percentage of playtime lost, rounded the way the report prints it; a trace is not "0.0". */
export const pct = (v: number) => (v < 0.05 ? 'under 0.1' : v < 10 ? v.toFixed(1) : Math.round(v).toString());

const stutters = (n: number) => (n === 1 ? 'one stutter' : n === 2 ? 'two stutters' : `${n} stutters`);

export interface Headline {
  title: string;
  summary: string;
  /** True when the main cause is one of the engine's: the summary carries the plan's sentence. */
  engine: boolean;
  tone: 'ok' | 'warn' | 'bad' | 'idle';
}

export const SHORT_SUMMARY = 'The first 300 frames are treated as the level load; capture a little longer.';

/**
 * Headline verdict and the one-sentence summary (§11: % of playtime lost and the main
 * cause). A cause only becomes the title once there are three or more stutters and the
 * capture is over the worth-fixing line; the border then is never the calm green. On
 * one signal the title starts with "Probably" and the sentence keeps the hedge.
 */
export function headline(r: StutterReport): Headline {
  const m = r.measurements;
  const top: CauseShare | undefined = r.causes[0];
  if (r.verdict === 'short') return { title: 'Not enough frames to judge', summary: SHORT_SUMMARY, engine: false, tone: 'idle' };
  if (m.stutters === 0 || !top) {
    return { title: 'Smooth', summary: `No stutters in this session; typical frame time ${m.typicalMs.toFixed(1)} ms.`, engine: false, tone: 'ok' };
  }
  const text = causeText(top.case);
  const lost = `${pct(m.lostPct)} % of playtime went to ${stutters(m.stutters)}`;
  const which = r.causes.length === 1 ? 'cause' : 'main cause';
  const summary = `${lost}; ${top.case === 0 ? 'no cause lined up with them' : `the ${which} was ${text.inSentence}`}.`;
  // Under the classifier's worth-fixing line the cause is a footnote, not the title.
  if (r.verdict === 'fine') return { title: 'No stutter worth fixing', summary, engine: false, tone: 'ok' };
  if (top.case === 0) return { title: 'No clear cause', summary, engine: false, tone: 'idle' };
  const engine = !text.fixable;
  // A cause the rule saw on one signal is a "probably", in the title and in the sentence; an engine cause hedges once, in the plan's sentence.
  const hedge = top.confidence === 'low';
  const sentence = hedge && !engine ? `${lost}; the ${which} was probably ${text.inSentence} — one signal only.` : summary;
  const title = m.stutters <= 2 ? (m.stutters === 1 ? 'One stutter' : 'Two stutters') : hedge ? `Probably ${text.inSentence}` : text.name;
  return {
    title,
    summary: engine ? `${sentence} ${engineSentence(top)}` : sentence,
    engine,
    tone: engine ? 'idle' : m.lostPct >= 5 ? 'bad' : 'warn'
  };
}
