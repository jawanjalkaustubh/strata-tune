import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReportView } from '../src/report/ReportView';
import { ShareCard } from '../src/report/ShareCard';
import { ENGINE_SENTENCE, ENGINE_SENTENCE_HEDGED, causeText, headline } from '../src/report/causes';
import { REPORT_SLOT, exportReport, readEmbeddedReport, reportFileName } from '../src/report/export';
import type { BenchCheck, Report, StutterReport } from '../src/report/report-types';
import type { Score } from '../src/analysis/score';
import benchJson from './fixtures/bench.report.json';

/** A synthetic 300 s bench (tests/fixtures/bench.report.json): shader compilation decaying, a thermal tail, engine stalls on a 2 s beat. */
const bench = (): Report => structuredClone(benchJson as Report);

const TEMPLATE = `<!doctype html><html><body><div id="root"></div>${REPORT_SLOT}<script type="module">/* app */</script></body></html>`;

describe('ReportView (plan §19)', () => {
  const { report, session } = bench();
  const html = renderToStaticMarkup(<ReportView report={report} session={session} />);

  it('reads top to bottom: verdict, chart, causes, bound, measurements', () => {
    const order = ['Verdict', 'Shader compilation', 'Frame time', 'What caused it', 'CPU or GPU', 'Measurements'].map((s) => html.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('says how much playtime went where, and marks every stutter on the chart', () => {
    expect(html).toContain('1.4 % of playtime went to 133 stutters; the main cause was shader compilation.');
    expect(html.match(/<circle /g)?.length).toBe(report.stutters.length);
    expect(html).toContain('typical 7.0 ms');
    expect(html).toContain('worst 1 % 18.8 ms');
  });

  it('gives the engine cases the plan’s sentence instead of advice', () => {
    expect(html).toContain(ENGINE_SENTENCE);
    expect(causeText(7).fixable).toBe(false);
    expect(causeText(8).action).toBe(ENGINE_SENTENCE);
    expect(causeText(2).action).toMatch(/fan curve/);
  });

  it('carries the bound sentence and the measurement rows in order', () => {
    expect(html).toContain(report.bound.sentence);
    const rows = ['Stutters', 'Playtime lost', 'Typical frame time', 'Worst 1 %', 'Pacing', 'Shader warm-up detected', 'Thermal throttling seen', 'Pacing issue'].map((s) => html.indexOf(`<td class="label">${s}</td>`));
    expect([...rows].sort((a, b) => a - b)).toEqual(rows);
  });

  it('loads nothing from the network: no external URL in the markup', () => {
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('labels the figures and counts signals rather than promising certainty', () => {
    expect(html).toContain('What caused it — share of lost time');
    expect(html).toContain('67 stutters · 2.6 s lost');
    expect(html).toContain('>2 signals<');
    expect(html).toContain('>1 signal<');
    expect(html).not.toMatch(/>sure</i);
    expect(html).not.toContain('#1');
    // Case 0 has no cause for a pill to be sure of.
    expect(html.match(/rp-pill/g)?.length).toBe(report.causes.length - 1);
  });

  it('draws the reference labels last, over the lines and the dots', () => {
    const labels = html.indexOf('ref-label ref-typical-t');
    expect(labels).toBeGreaterThan(html.lastIndexOf('<circle '));
    expect(labels).toBeGreaterThan(html.indexOf('class="ref-worst"'));
    expect(html.indexOf('ref-label ref-worst-t')).toBeGreaterThan(labels);
  });

  it('puts a spike above the chart in the legend only when there is one', () => {
    // The bench has 95–108 ms spikes on an 80 ms axis.
    expect(html).toContain('above the chart — hover for the value');
    const r = bench();
    r.report.stutters = r.report.stutters.map((s) => ({ ...s, ms: 20 }));
    expect(renderToStaticMarkup(<ReportView report={r.report} session={r.session} />)).not.toContain('above the chart');
  });

  it('drops the monogram and wordmark for the app, which carries them in its title bar', () => {
    const inApp = renderToStaticMarkup(<ReportView report={report} session={session} brand={false} />);
    expect(inApp).not.toContain('data:image/png');
    expect(inApp).not.toContain('>Strata Tune</div>');
    expect(inApp).toContain('Bench report');
    expect(html).toContain('data:image/png');
  });

  it('says how many frames the level load took', () => {
    const withCount = renderToStaticMarkup(<ReportView report={report} session={{ ...session, framesCaptured: 41550 }} />);
    expect(withCount).toContain('First 300 of 41,550 captured frames skipped as the level load.');
    expect(html).not.toContain('skipped as the level load');
  });

  it('under the worth-fixing line the cause row is for the record, with nothing to do', () => {
    const r = bench();
    r.report.verdict = 'fine';
    r.report.causes = [{ case: 4, count: 1, share: 1, lostMs: 5, confidence: 'high', detail: 'video memory 99 % full · GPU busy 8.1 ms on this frame' }];
    r.report.measurements = { ...r.report.measurements, stutters: 1, lostPct: 0.03 };
    const fine = renderToStaticMarkup(<ReportView report={r.report} session={r.session} />);
    expect(fine).toContain('The one stutter, for the record');
    expect(fine).toContain('Nothing to do at this level.');
    expect(fine).not.toContain('Lower the texture quality');
    expect(fine).toContain('rp-pill idle');
    expect(fine).toContain('video memory 99 % full · GPU busy 8.1 ms on this frame');
  });

  it('a capture inside the level load shows the verdict alone', () => {
    const r = bench();
    r.report.verdict = 'short';
    r.report.causes = [];
    r.report.stutters = [];
    r.report.timeline = [];
    r.report.measurements = { ...r.report.measurements, stutters: 0, lostPct: 0, typicalMs: 0 };
    const short = renderToStaticMarkup(<ReportView report={r.report} session={{ ...r.session, frames: 0, framesCaptured: 250 }} />);
    expect(short).toContain('Not enough frames to judge');
    expect(short).toContain('rp-verdict idle');
    expect(short).not.toContain('Smooth');
    expect(short).not.toContain('rp-chart');
    expect(short).not.toContain('Measurements');
    expect(short).toContain('All 250 captured frames fall inside the 300-frame level load.');
  });
});

describe('headline', () => {
  it('an engine cause on top puts the sentence in the summary', () => {
    const r = bench().report;
    r.causes = [{ case: 8, count: 40, share: 1, lostMs: 800, confidence: 'high' }];
    const h = headline(r);
    expect(h.title).toBe('Engine stall');
    expect(h.engine).toBe(true);
    expect(h.summary).toContain(ENGINE_SENTENCE);
  });

  it('a fine verdict keeps the cause out of the title, keeps the acronym, and does not print a trace as 0.0', () => {
    const r: StutterReport = { ...bench().report, verdict: 'fine', causes: [{ case: 4, count: 1, share: 1, lostMs: 5, confidence: 'low' }] };
    r.measurements = { ...r.measurements, stutters: 1, lostPct: 0.02 };
    const h = headline(r);
    expect(h.title).toBe('No stutter worth fixing');
    expect(h.summary).toBe('under 0.1 % of playtime went to one stutter; the cause was VRAM exhaustion.');
    expect(h.tone).toBe('ok');
  });

  it('one or two stutters over the line are titled by their count, never with the calm green', () => {
    const r: StutterReport = { ...bench().report, verdict: 'unclear', causes: [{ case: 4, count: 1, share: 1, lostMs: 200, confidence: 'high' }] };
    r.measurements = { ...r.measurements, stutters: 1, lostPct: 1.1 };
    const one = headline(r);
    expect(one.title).toBe('One stutter');
    expect(one.summary).toBe('1.1 % of playtime went to one stutter; the cause was VRAM exhaustion.');
    expect(one.tone).toBe('warn');
    r.measurements.stutters = 2;
    expect(headline(r).title).toBe('Two stutters');
    r.measurements.stutters = 3;
    expect(headline(r)).toMatchObject({ title: 'VRAM exhaustion', tone: 'warn' });
  });

  it('on one signal the title starts with Probably and the sentence keeps the hedge', () => {
    const r: StutterReport = { ...bench().report, verdict: 'unclear', causes: [{ case: 4, count: 3, share: 1, lostMs: 200, confidence: 'low' }] };
    r.measurements = { ...r.measurements, stutters: 3, lostPct: 1.1 };
    expect(headline(r)).toMatchObject({ title: 'Probably VRAM exhaustion', summary: '1.1 % of playtime went to 3 stutters; the cause was probably VRAM exhaustion — one signal only.', tone: 'warn' });
    r.measurements.stutters = 1;
    expect(headline(r)).toMatchObject({ title: 'One stutter', summary: '1.1 % of playtime went to one stutter; the cause was probably VRAM exhaustion — one signal only.' });
    r.causes = [{ case: 8, count: 40, share: 0.8, lostMs: 800, confidence: 'low' }, { case: 2, count: 4, share: 0.2, lostMs: 100, confidence: 'high' }];
    r.measurements.stutters = 44;
    const engine = headline(r);
    expect(engine.title).toBe('Probably an engine stall');
    // The hedge is in the plan's sentence, once: not "was probably an engine stall. Probably nothing".
    expect(engine.summary).toBe(`1.1 % of playtime went to 44 stutters; the main cause was an engine stall. ${ENGINE_SENTENCE_HEDGED}`);
    expect(engine.summary.match(/probably/gi)?.length).toBe(1);
    expect(engine.engine).toBe(true);
    r.causes[0].confidence = 'high';
    expect(headline(r).title).toBe('Engine stall');
  });

  it('a cause on top is never paired with the ok tone', () => {
    const r: StutterReport = { ...bench().report, verdict: 'fixable', causes: [{ case: 2, count: 5, share: 1, lostMs: 300, confidence: 'high' }] };
    r.measurements = { ...r.measurements, stutters: 5, lostPct: 0.3 };
    expect(headline(r)).toMatchObject({ title: 'Thermal throttle', tone: 'warn' });
    r.measurements.lostPct = 6;
    expect(headline(r).tone).toBe('bad');
  });

  it('no signature on top is No clear cause, in the idle tone', () => {
    const r: StutterReport = { ...bench().report, verdict: 'unclear', causes: [{ case: 0, count: 6, share: 1, lostMs: 300, confidence: 'low' }] };
    r.measurements = { ...r.measurements, stutters: 6, lostPct: 0.8 };
    const h = headline(r);
    expect(h.title).toBe('No clear cause');
    expect(h.summary).toBe('0.8 % of playtime went to 6 stutters; no cause lined up with them.');
    expect(h.tone).toBe('idle');
  });

  it('hedges the engine sentence on one signal', () => {
    const r = bench().report;
    r.causes = [{ case: 8, count: 40, share: 1, lostMs: 800, confidence: 'low' }];
    expect(headline(r).summary).toContain(ENGINE_SENTENCE_HEDGED);
    expect(headline(r).summary).not.toContain(ENGINE_SENTENCE);
    const view = renderToStaticMarkup(<ReportView report={r} session={bench().session} />);
    expect(view).toContain(ENGINE_SENTENCE_HEDGED);
  });

  it('a short capture is not Smooth', () => {
    const r: StutterReport = { ...bench().report, verdict: 'short', causes: [], stutters: [] };
    r.measurements = { ...r.measurements, stutters: 0, lostPct: 0, typicalMs: 0 };
    const h = headline(r);
    expect(h.title).toBe('Not enough frames to judge');
    expect(h.tone).toBe('idle');
    expect(h.summary).toMatch(/first 300 frames/);
  });

  it('no stutters is Smooth', () => {
    const r: StutterReport = { ...bench().report, causes: [], stutters: [] };
    r.measurements = { ...r.measurements, stutters: 0, lostPct: 0 };
    expect(headline(r).title).toBe('Smooth');
    expect(headline(r).tone).toBe('ok');
  });
});

describe('bench check (plan §11a)', () => {
  const check: BenchCheck = {
    script: 'full',
    assumedTimings: false,
    rows: [
      { segment: 'warm-up', startS: 0, endS: 10, designed: null, weak: [], found: 1, stutters: 3, lostPct: 1.57, reached: true, scored: false, match: false },
      { segment: 'shader-compile', startS: 10, endS: 30, designed: 1, weak: [], found: 1, stutters: 15, lostPct: 2.66, reached: true, scored: true, match: true },
      { segment: 'texture-stream', startS: 30, endS: 45, designed: null, weak: [4, 5], found: 7, stutters: 5, lostPct: 1.82, reached: true, scored: true, match: false },
      { segment: 'cpu-stall', startS: 45, endS: 60, designed: 7, weak: [], sameVerdict: [8], found: 7, stutters: 8, lostPct: 2.02, reached: true, scored: true, match: true },
      { segment: 'gpu-load', startS: 60, endS: 90, designed: null, weak: [2, 3], found: 8, stutters: 5, lostPct: 0.43, reached: true, scored: true, match: true }
    ],
    matched: 3,
    scored: 4,
    score: '3 of 4 designed segments classified as designed'
  };

  it('renders under the causes as a table with a mark per scored segment', () => {
    const r = bench();
    r.report.benchCheck = check;
    const html = renderToStaticMarkup(<ReportView report={r.report} session={r.session} />);
    expect(html.indexOf('Bench check')).toBeGreaterThan(html.indexOf('What caused it'));
    expect(html.indexOf('Bench check')).toBeLessThan(html.indexOf('CPU or GPU'));
    expect(html).toContain('3 of 4 designed segments classified as designed.');
    expect(html).not.toContain('carried no bench summary');
    expect(html.match(/rp-bench-table.*?<\/table>/s)![0].match(/<tr/g)?.length).toBe(6);
    // The script's id prints as its label (benchmarks.json), the same word the live line used.
    expect(html).toContain('<td>Shader compile</td>');
    expect(html).toContain('10–30 s');
    expect(html).toContain('<td>Shader compilation</td><td>Shader compilation · 15 stutters · 2.7 % lost</td>');
    expect(html).toContain('<td>clean, or VRAM exhaustion / storage on a weak machine</td><td>Engine tick · 5 stutters · 1.8 % lost</td>');
    expect(html).toContain('<td>clean, or thermal throttling / the power limit on a weak machine</td><td>Engine stall · 5 stutters · 0.4 % lost, under the worth-fixing line</td>');
    expect(html).toContain('<td>clean, ignored</td>');
    expect(html).toContain('<td>Engine tick or an engine stall</td><td>Engine tick · 8 stutters · 2.0 % lost</td>');
    expect(html.match(/figure ok">✓</g)?.length).toBe(3);
    expect(html.match(/figure warn">✗</g)?.length).toBe(1);
    expect(html.match(/figure idle">—</g)?.length).toBe(1);
    expect(html).toContain('class="unscored"');
  });

  it('says when the timings were assumed and when a segment was never reached', () => {
    const r = bench();
    r.report.benchCheck = { ...check, assumedTimings: true, rows: check.rows.map((row) => (row.segment === 'gpu-load' ? { ...row, found: null, stutters: 0, lostPct: 0, reached: false, scored: false, match: false } : row)), matched: 2, scored: 3, score: '2 of 3 designed segments classified as designed' };
    const html = renderToStaticMarkup(<ReportView report={r.report} session={r.session} />);
    expect(html).toContain('this session carried no bench summary');
    expect(html).toContain('<td>not reached</td>');
    expect(html.match(/figure idle">—</g)?.length).toBe(2);
  });

  it('a game report has no bench table', () => {
    const { report, session } = bench();
    expect(renderToStaticMarkup(<ReportView report={report} session={session} />)).not.toContain('Bench check');
  });
});

describe('exportReport', () => {
  it('fills the slot with the report JSON and the page reads it back', () => {
    const { report, session } = bench();
    const html = exportReport(report, session, TEMPLATE);
    expect(html).not.toContain(REPORT_SLOT);
    const json = html.match(/<script type="application\/json" id="strata-report">(.*?)<\/script>/s)![1];
    const doc = { getElementById: (id: string) => (id === 'strata-report' ? { textContent: json } : null) } as unknown as Document;
    expect(readEmbeddedReport(doc)).toEqual({ report, session });
    expect(readEmbeddedReport({ getElementById: () => ({ textContent: '' }) } as unknown as Document)).toBeNull();
  });

  it('a "</script" in a game name cannot end the data block', () => {
    const { report, session } = bench();
    const html = exportReport(report, { ...session, game: 'evil</script><script>alert(1)</script>' }, TEMPLATE);
    expect(html.match(/<\/script>/g)?.length).toBe(2);
    expect(html).toContain('evil\\u003c/script');
  });

  it('refuses a template without the slot', () => {
    const { report, session } = bench();
    expect(() => exportReport(report, session, '<html></html>')).toThrow(/build:report/);
  });

  it('names the file after the game and the start time', () => {
    expect(reportFileName({ ...bench().session, game: 'Cyberpunk2077.exe', startedAt: '2026-09-16T21:30:00' })).toBe('strata-tune-cyberpunk2077-2026-09-16-2130.html');
    expect(reportFileName({ ...bench().session, game: '', startedAt: 'nope' })).toBe('strata-tune-session-undated.html');
  });
});

describe('ShareCard (plan §14)', () => {
  const score: Score = {
    total: 78, subscores: { configuration: 90, thermals: 58, smoothness: 88, efficiency: 70 }, complete: true, capped: false, valid: true, invalidReasons: [],
    topFix: { id: 'thermal-headroom', title: 'GPU thermal headroom', state: 'warn', severity: 2, costEstimate: 0.08, costText: '', detail: '', fix: '', fixWhere: 'hardware' }
  };
  it('is 1200×630 with the total, four bars, the top fix, the hardware line and the monogram', () => {
    const svg = renderToStaticMarkup(<ShareCard score={score} hardware="AMD Ryzen 9 9950X · GeForce RTX 5090" date="2026-09-16" />);
    expect(svg).toMatch(/^<svg[^>]*width="1200" height="630"/);
    expect(svg).toContain('>78<');
    expect(svg.match(/rx="5"/g)?.length).toBe(8);
    expect(svg).toContain('GPU thermal headroom');
    expect(svg).toContain('GeForce RTX 5090');
    expect(svg).toContain('href="data:image/png;base64,');
    expect(svg.replace('xmlns="http://www.w3.org/2000/svg"', '')).not.toMatch(/https?:\/\//);
  });

  it('an invalid run says so instead of a number', () => {
    const svg = renderToStaticMarkup(<ShareCard score={{ ...score, total: null, valid: false, invalidReasons: ['another program was busy during the run'] }} hardware="x" />);
    expect(svg).toContain('Not comparable');
    expect(svg).toContain('another program was busy during the run');
  });
});
