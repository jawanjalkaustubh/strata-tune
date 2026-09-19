import React from 'react';
import type { ScoredRun, TuneCandidate, TuneLadderKind, TunePhase, TuneRun } from '../../collector-types';
import { TONE, type Tone } from '../monitor/Pill';
import { candidateTitle, laddersOf, offsetOf, points, rungsOf, signed, STAGE_NAME, tripped, VERDICT_TONE, type Offsets } from './wire';

const PHASE: Record<TunePhase, string> = {
  reference: 'reading the stock hash',
  'as-found': 'scoring the card as found (two minutes, nothing written)',
  vendor: 'writing your vendor tune through our route',
  climb: 'climbing',
  bisect: 'bisecting',
  official: 'the official two-minute run of the certified pair',
  restore: 'restoring the baseline',
  'holds-now': 'reading what the card holds now'
};

const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/**
 * One step of the climb: the offset above, the points (or what stopped it) beneath, in the
 * verdict's colour, and the gain against the card as found as a small third line so the reader
 * never subtracts four-digit figures in their head; the certified rung is outlined (plan 17a).
 */
const Step: React.FC<{ label: string; value: string; tone: Tone; hollow?: boolean; title: string; delta?: string; certified?: boolean }> = ({ label, value, tone, hollow, title, delta, certified }) => (
  <span className={`inline-flex flex-col items-center px-2 py-1 rounded border min-w-[3.5rem] ${hollow ? 'border-dashed' : ''} ${certified ? 'ring-1 ring-emerald-400/70' : ''} ${TONE[tone].border} ${hollow ? '' : TONE[tone].dim}`} title={title} aria-label={title}>
    <span className="figure text-[11px] text-studio-muted whitespace-nowrap">{label}</span>
    <span className={`figure text-[12px] whitespace-nowrap ${TONE[tone].text}`}>{value}</span>
    {delta && <span className="figure text-[10px] text-studio-subtle whitespace-nowrap">{delta}</span>}
  </span>
);

/** "+0.3 %" against the as-found score; nothing without both figures. */
const gain = (points_: number | undefined, asFound: number | undefined) => (points_ !== undefined && asFound !== undefined && asFound > 0 ? `${points_ >= asFound ? '+' : '−'}${(Math.abs(points_ - asFound) * 100 / asFound).toFixed(1)} %` : undefined);

/** "→" between steps, so a row reads as the export text does: "+0 → 10,420 · +15 → 10,480"; the one rung at +0 is the vendor tune written through our route, and says so. */
const Arrow: React.FC = () => <span className="text-studio-subtle select-none">→</span>;

const rungValue = (c: TuneCandidate) => {
  if (c.score) return points(c.score.points);
  if (tripped(c)) return `${c.stage ? STAGE_NAME[c.stage] ?? 'failed' : 'failed'}, stopped`;
  return c.verdict === 'invalid' ? 'invalid' : 'held';
};

interface Props {
  run: TuneRun | null;
  /** The last result's rungs, drawn when no live run is on the wire (the page reopened after a hunt). */
  rungs: readonly TuneCandidate[];
  /** The as-found scored run: from the live run once it has scored, or from the result. */
  asFound: ScoredRun | null;
  /** The certified pair's official run, once it exists. */
  official: ScoredRun | null;
  /** The P0 deltas every rung sits on; offsets are shown above it. */
  baseline: Offsets | null;
}

/**
 * The ladder as a score climb (plan section 16, 'every rung is scored'): one row per
 * ladder, the as-found card first, each rung as "+15 → 10,480" in the verdict's colour
 * (emerald held, rose tripped with its stage, amber invalid), the rung under test hollow
 * with its half and clock, the official run last. Plain DOM that wraps; nothing is clipped
 * and nothing animates (plan 17a, 17c).
 */
export const ScoreClimb: React.FC<Props> = ({ run, rungs, asFound, official, baseline }) => {
  if (!run && !asFound && rungs.length === 0) return <p className="text-mini text-studio-muted px-1">No rungs yet. A hunt scores the card as found, then climbs one small step at a time and scores each rung here.</p>;
  const running = run?.state === 'running';
  const candidates = run ? run.candidates : rungs;
  const scored = [asFound, official];
  const ladders: TuneLadderKind[] = laddersOf(candidates, running ? run.ladder : null, scored);
  const current = running ? run.candidate : null;
  const found = asFound?.score ? `${points(asFound.score.points)}` : asFound ? asFound.note || 'not scored' : running && run.phase === 'as-found' ? 'scoring…' : 'pending';
  const foundTone: Tone = asFound?.score ? 'ok' : asFound ? 'warn' : 'idle';
  const foundPoints = asFound?.score?.points;
  // The certified rung of each ladder: the official pair's offset on that axis, else the highest stable rung.
  const certifiedOf = (ladder: TuneLadderKind, steps: readonly TuneCandidate[]) => {
    if (official) return official.deltas[ladder === 'memory' ? 'memMhz' : 'coreMhz'] - (baseline ? baseline[ladder === 'memory' ? 'memMhz' : 'coreMhz'] : 0);
    const stable = steps.filter((c) => c.verdict === 'stable' && offsetOf(c, baseline) > 0);
    return stable.length ? Math.max(...stable.map((c) => offsetOf(c, baseline))) : null;
  };
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="label">
          Score climb
          {run && <span className="text-studio-subtle ml-3 normal-case tracking-normal">{running ? `${PHASE[run.phase]}${run.repeat > 0 ? ` · repeat ${run.repeat}` : ''}` : `${run.kind} run ${run.state}`}</span>}
        </span>
        <span className="flex flex-wrap items-center gap-3 text-micro text-studio-subtle">
          <Key tone="ok" text="held" /> <Key tone="bad" text="tripped" /> <Key tone="warn" text="invalid" /> <Key tone="info" text="under test" hollow />
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 w-full">
        <Step label="as found" value={found} tone={foundTone} hollow={!asFound} title={asFound ? `The card as found: ${asFound.repeats} repeats, ${asFound.note}${asFound.held ? `, held ${asFound.held.smMhz} / ${asFound.held.memMhz} MHz` : ''}` : 'The card as found is scored before anything is written'} />
        {ladders.map((ladder) => {
          const steps = rungsOf(candidates, ladder, scored);
          const testing = current && running && run.ladder === ladder;
          return (
            <React.Fragment key={ladder}>
              <span className="label ml-2">{ladder}</span>
              {steps.map((c, i) => (
                <React.Fragment key={i}>
                  <Arrow />
                  <Step
                    label={offsetOf(c, baseline) === 0 ? 'vendor' : signed(offsetOf(c, baseline))}
                    value={rungValue(c)}
                    tone={VERDICT_TONE[c.verdict]}
                    title={candidateTitle(c, baseline)}
                    delta={gain(c.score?.points, foundPoints)}
                    certified={!running && offsetOf(c, baseline) > 0 && offsetOf(c, baseline) === certifiedOf(ladder, steps)}
                  />
                </React.Fragment>
              ))}
              {testing && (
                <>
                  <Arrow />
                  <Step
                    label={signed(offsetOf({ ladder, deltas: current }, baseline))}
                    value={run.pattern ? `${run.pattern} ${mmss(run.patternElapsedS)} / ${mmss(run.patternSeconds)}` : 'starting'}
                    tone="info"
                    hollow
                    title={`${ladder} ${signed(offsetOf({ ladder, deltas: current }, baseline))} MHz: under test (${run.pattern ?? 'starting'})`}
                  />
                </>
              )}
            </React.Fragment>
          );
        })}
        {(official || (running && run.phase === 'official')) && (
          <>
            <span className="label ml-2">official</span>
            <Arrow />
            <Step
              label={official ? `${signed(official.deltas.coreMhz - (baseline?.coreMhz ?? 0))} / ${signed(official.deltas.memMhz - (baseline?.memMhz ?? 0))}` : 'pair'}
              value={official?.score ? points(official.score.points) : official ? `${official.note || 'failed'}` : running && run.pattern ? `${run.pattern} ${mmss(run.patternElapsedS)} / ${mmss(run.patternSeconds)}` : 'running'}
              tone={official?.score ? 'ok' : official ? 'bad' : 'info'}
              hollow={!official}
              title={official ? `The official run: ${official.repeats} repeats, ${official.note}${official.steppedDown ? ', one fine step below the ladders' : ''}` : 'The certified pair under the two-minute scored run'}
              delta={official?.score ? `${gain(official.score.points, foundPoints) ?? ''} over as found` : undefined}
            />
          </>
        )}
      </div>
    </div>
  );
};

const Key: React.FC<{ tone: Tone; text: string; hollow?: boolean }> = ({ tone, text, hollow }) => (
  <span className="inline-flex items-center gap-1">
    <span className={`inline-block w-2.5 h-2.5 rounded-sm border ${TONE[tone].border} ${hollow ? 'border-dashed' : TONE[tone].dim}`} /> {text}
  </span>
);
