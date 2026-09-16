import React from 'react';
import { WARMUP_FRAMES } from '../analysis/frames';
import { LOGO_DATA_URL } from '../assets/logo';
import { FrameTimeChart, dotTone } from './FrameTimeChart';
import { causeText, engineSentence, headline, pct } from './causes';
import type { BoundVerdict, CauseShare, Measurements, SessionSummary, StutterReport } from './report-types';
import './report.css';

interface Props {
  report: StutterReport;
  session: SessionSummary;
  /** Monogram and wordmark in the header: on in the exported file, off in the app, whose title bar already carries them. */
  brand?: boolean;
}

const fmtDuration = (s: number) => {
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : m > 0 ? `${m} min ${r} s` : `${r} s`;
};

const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

const fmtLost = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);

const Bar: React.FC<{ fraction: number; tone: 'ok' | 'warn' | 'bad' | 'idle' }> = ({ fraction, tone }) => (
  <div className="rp-bar">
    <i className={tone} style={{ width: `${(Math.min(Math.max(fraction, 0), 1) * 100).toFixed(1)}%` }} />
  </div>
);

/**
 * One cause: name, its share of the lost time, the count and the time, the signal
 * count, then the paragraph, the action and the evidence line. Under the worth-fixing
 * line there is nothing to do, and the row says so instead of an instruction.
 */
const Cause: React.FC<{ c: CauseShare; fine: boolean }> = ({ c, fine }) => {
  const text = causeText(c.case);
  const tone = fine ? 'idle' : dotTone(c.case);
  return (
    <div className="rp-cause">
      <div className="rp-cause-row">
        <div className="rp-cause-name" title={c.case > 0 ? `Signature ${c.case} of the nine` : undefined}>
          <span>{text.name}</span>
        </div>
        <Bar fraction={c.share} tone={tone} />
        <div className="rp-cause-fig">
          <span className="figure">{pct(c.share * 100)} %</span>
          <span className="sub figure">
            {c.count === 1 ? 'one stutter' : `${c.count} stutters`} · {fmtLost(c.lostMs)} lost
          </span>
          {c.case > 0 && (
            <span className={`rp-pill ${!fine && c.confidence === 'high' ? 'ok' : 'idle'}`} title={c.confidence === 'high' ? 'Two signals agreed on the cause' : 'One signal pointed at the cause'}>
              {c.confidence === 'high' ? '2 signals' : '1 signal'}
            </span>
          )}
        </div>
      </div>
      <p>{text.paragraph}</p>
      {fine ? (
        <div className="rp-action engine">Nothing to do at this level.</div>
      ) : (
        <div className={`rp-action ${text.fixable ? '' : 'engine'}`}>
          <span className="label">{text.label}</span>
          {text.fixable ? text.action : engineSentence(c)}
        </div>
      )}
      {c.detail && <div className="rp-detail">{c.detail}</div>}
    </div>
  );
};

/** The limiting side carries the colour and the other is slate; amber is kept for a real near-limit state, and a GPU-bound game is the normal one. */
const Bound: React.FC<{ b: BoundVerdict }> = ({ b }) => {
  const scale = Math.max(b.meanCpuBusyMs, b.meanGpuBusyMs, 0.1);
  const tone = (side: 'cpu' | 'gpu') => (b.side === side || b.side === 'balanced' ? 'ok' : 'idle');
  return (
    <section className="rp-panel rp-bound">
      <div className="label">CPU or GPU</div>
      <p>{b.sentence}</p>
      <div className="rp-rows">
        <div className="rp-row">
          <span className="label">CPU per frame</span>
          <Bar fraction={b.meanCpuBusyMs / scale} tone={tone('cpu')} />
          <span className="figure">{b.meanCpuBusyMs.toFixed(1)} ms</span>
        </div>
        <div className="rp-row">
          <span className="label">GPU per frame</span>
          <Bar fraction={b.meanGpuBusyMs / scale} tone={tone('gpu')} />
          <span className="figure">{b.meanGpuBusyMs.toFixed(1)} ms</span>
        </div>
        {b.gpuUtilPct !== null && (
          <div className="rp-row">
            <span className="label">GPU busy</span>
            <Bar fraction={b.gpuUtilPct / 100} tone={b.gpuUtilPct < 70 ? 'idle' : 'ok'} />
            <span className="figure">{Math.round(b.gpuUtilPct)} %</span>
          </div>
        )}
      </div>
    </section>
  );
};

const yesNo = (v: boolean) => (v ? 'yes' : 'no');

const Table: React.FC<{ m: Measurements }> = ({ m }) => (
  <section className="rp-panel">
    <div className="label">Measurements</div>
    <table className="rp-table">
      <tbody>
        <tr>
          <td className="label">Stutters</td>
          <td>{m.stutters}</td>
        </tr>
        <tr>
          <td className="label">Playtime lost</td>
          <td>{pct(m.lostPct)} %</td>
        </tr>
        <tr>
          <td className="label">Typical frame time</td>
          <td>
            {m.typicalMs.toFixed(1)} ms<span className="sub">median</span>
          </td>
        </tr>
        <tr>
          <td className="label">Worst 1 %</td>
          <td>{m.worst1PctMs.toFixed(1)} ms</td>
        </tr>
        <tr>
          <td className="label">Pacing</td>
          <td>
            {m.pacingStdevMs.toFixed(2)} ms<span className="sub">stdev outside stutters</span>
          </td>
        </tr>
        <tr>
          <td className="label">Shader warm-up detected</td>
          <td>{yesNo(m.shaderWarmup)}</td>
        </tr>
        <tr>
          <td className="label">Thermal throttling seen</td>
          <td>{yesNo(m.thermalThrottling)}</td>
        </tr>
        <tr>
          <td className="label">Pacing issue</td>
          <td>{yesNo(m.pacingIssue)}</td>
        </tr>
      </tbody>
    </table>
  </section>
);

/** The cause section's label: what the shares are of, or, under the worth-fixing line, that the rows are for the record. */
const causesLabel = (fine: boolean, stutters: number) =>
  fine ? `The ${stutters === 1 ? 'one stutter' : `${stutters} stutters`}, for the record` : 'What caused it — share of lost time';

/** The level-load note for the footer: how many of the captured frames the analysis skipped. */
const skipNote = (s: SessionSummary) => {
  if (s.framesCaptured === undefined) return null;
  const skipped = s.framesCaptured - s.frames;
  return skipped >= s.framesCaptured
    ? `All ${s.framesCaptured.toLocaleString()} captured frames fall inside the ${WARMUP_FRAMES}-frame level load.`
    : `First ${skipped.toLocaleString()} of ${s.framesCaptured.toLocaleString()} captured frames skipped as the level load.`;
};

/**
 * The stutter report (plan §11, §19), top to bottom: headline verdict, one sentence,
 * the frame-time chart, each cause as a share with plain words and an action, the
 * CPU/GPU-bound sentence, and the measurements last. Renders the same in the
 * Capture page and in the exported file; a capture that never left the level load
 * shows the verdict alone, since every number under it would be zero.
 */
export const ReportView: React.FC<Props> = ({ report, session, brand = true }) => {
  const h = headline(report);
  const m = report.measurements;
  const short = report.verdict === 'short';
  const fine = report.verdict === 'fine';
  const skip = skipNote(session);
  return (
    <div className="rp">
      <div className="rp-page">
        <header className="rp-head">
          <div className="rp-brand">
            {brand && <img src={LOGO_DATA_URL} alt="" />}
            <div>
              {brand && <div className="label">Strata Tune</div>}
              <div className="label rp-kind">{session.bench ? 'Bench report' : 'Stutter report'}</div>
            </div>
          </div>
          <div className="rp-meta">
            <div>
              <span className="figure">{session.game}</span> · {fmtDate(session.startedAt)}
            </div>
            <div>
              <span className="figure">{fmtDuration(session.durationS)}</span> · <span className="figure">{session.frames.toLocaleString()}</span> frames analysed
              {session.presentMode ? ` · ${session.presentMode}` : ''}
            </div>
            <div>
              {session.cpu} · {session.gpu}
            </div>
          </div>
        </header>

        <section className={`rp-panel rp-verdict ${h.tone}`}>
          <div className="label">Verdict</div>
          <h1>{h.title}</h1>
          <p>{h.summary}</p>
          {!short && (
            <div className="rp-figures">
              <div>
                <div className={`figure ${h.tone}`}>{pct(m.lostPct)} %</div>
                <div className="label">playtime lost</div>
              </div>
              <div>
                <div className="figure">{m.stutters}</div>
                <div className="label">stutters</div>
              </div>
              <div>
                <div className="figure">{m.typicalMs.toFixed(1)} ms</div>
                <div className="label">typical frame</div>
              </div>
              <div>
                <div className="figure">{m.worst1PctMs.toFixed(1)} ms</div>
                <div className="label">worst 1 %</div>
              </div>
            </div>
          )}
        </section>

        {!short && (
          <section className="rp-panel">
            <div className="label">Frame time</div>
            <FrameTimeChart timeline={report.timeline} stutters={report.stutters} measurements={m} durationS={session.durationS} />
          </section>
        )}

        {!short && report.causes.length > 0 && (
          <section className="rp-panel">
            <div className="label">{causesLabel(fine, m.stutters)}</div>
            {report.causes.map((c) => (
              <Cause key={c.case} c={c} fine={fine} />
            ))}
          </section>
        )}

        {!short && (
          <div className="rp-grid">
            <Bound b={report.bound} />
            <Table m={m} />
          </div>
        )}

        <footer className="rp-foot">
          <span>
            Frames from PresentMon per present; sensors at 10 Hz; a stutter is a frame over twice the rolling median or over 50 ms.{skip ? ` ${skip}` : ''}
          </span>
          <span>Strata Tune{session.appVersion ? ` ${session.appVersion}` : ''}</span>
        </footer>
      </div>
    </div>
  );
};
