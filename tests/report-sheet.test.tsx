import { describe, expect, it } from 'vitest';
import React from 'react';
import * as os from 'os';
import { readFileSync } from 'fs';
import { basename, join } from 'path';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TuneExport, TuneStatus } from '../src/collector-types';
import { benchSheet, headroomSheet } from '../src/report/sheet';
import { HeadroomCard, ScoreSheetView } from '../src/report/ScoreSheet';
import { ReportFileView } from '../src/report/ReportView';
import { REPORT_SLOT, exportReportFile, readEmbeddedReport, reportFileNameOf, scoreSheetFileName } from '../src/report/export';
import { REDACTED } from '../src/components/about/systemReport';
import { analyse } from '../src/components/capture/toReport';
import { benchSession } from './fixtures/bench-session';
import { devbox } from './fixtures';

const high = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'classes', 'high-end-pc.tune.json'), 'utf8')) as { tune: { status: TuneStatus; export: TuneExport } };
const TEMPLATE = `<!doctype html><html><body><div id="root"></div>${REPORT_SLOT}<script type="module">/* app */</script></body></html>`;

/** The dev box with the things a sheet must never carry: a board serial, a PCI instance id in a GPU name, a serial line in a rung note. */
function dirtySnapshot() {
  const s = devbox();
  (s.motherboard as unknown as Record<string, unknown>).serialNumber = '07E5920_O81B000000';
  s.gpus[0].name = 'NVIDIA GeForce RTX 5090 PCI\\VEN_10DE&DEV_2B85&SUBSYS_89EC1043&REV_A1\\4&7E5920&0&0008';
  return s;
}

const context = () => ({ snapshot: dirtySnapshot(), gpu: dirtySnapshot().gpus[0], version: '0.1.0', deviceClass: 'high-end-pc' as const, psu: { watts: 1300, rating: 'platinum' as const }, windows: 'Windows 11 Home 25H2 build 26200.1234', dimmVoltage: 1.35 });

describe('the comparison sheet (plan §16 "Save as .html")', () => {
  const exp = { ...high.tune.export, rungs: high.tune.export.rungs.map((r, i) => (i === 0 ? { ...r, note: 'vendor rung, Serial Number: 07E5920X' } : r)) };
  const sheet = headroomSheet(exp, high.tune.status.result!, context());

  it('is built from the export: the official score, the as-found points, the certified pair in both units, every rung, the telemetry, the hardware line, the PSU as set, the validity block', () => {
    expect(sheet.run).toBe('headroom');
    expect(sheet.score?.points).toBe(11812);
    expect(sheet.asFoundPoints).toBe(11701);
    expect(sheet.certified).toEqual({ coreMhz: 45, memMhz: 60 });
    expect(sheet.vendorSlider).toEqual({ coreMhz: 45, memMhz: 120 });
    expect(sheet.sliderTotal).toEqual({ coreMhz: 364, memMhz: 4192 });
    expect(sheet.rungs.length).toBe(9);
    expect(sheet.rungs[1]).toMatchObject({ ladder: 'memory', offsetMhz: 15, verdict: 'stable', points: 11704 });
    expect(sheet.rungs[8]).toMatchObject({ ladder: 'core', offsetMhz: 60, verdict: 'unstable', stage: 1, points: null });
    expect(sheet.telemetry?.gpu?.memoryJunctionC?.max).toBe(77);
    expect(sheet.telemetry?.cpu?.tctlC?.max).toBe(67);
    expect(sheet.hardware).toMatchObject({ cpu: 'AMD Ryzen 9 9950X 16-Core Processor', bios: '2.A60', driver: '616.92', windows: 'Windows 11 Home 25H2 build 26200.1234' });
    expect(sheet.hardware.board).toContain('MAG X870E TOMAHAWK WIFI');
    expect(sheet.psu).toEqual({ watts: 1300, rating: '80 PLUS Platinum' });
    expect(sheet.ram).toMatchObject({ configuredMts: 6200, dimmVoltage: 1.35, modules: 2, totalGiB: 32 });
    expect(sheet.deviceClass).toBe('high-end PC');
    expect(sheet.validity.map((v) => [v.label, v.ok])).toEqual([
      ['Fixed workload', true],
      ['Hash checks', true],
      ['No thermal limit', true],
      ['Background load', null]
    ]);
    expect(sheet.lines.join('\n')).toContain('Type into GPU Tweak / Afterburner: core +364, memory +4192');
    expect(sheet.held.now).toEqual({ smMhz: 3225, memMhz: 16037 });
    // The ladder stops and the confidence's why travel with the sheet, so a file that says "+0 core" says why.
    expect(sheet.stops).toEqual(high.tune.status.result!.stops.map((s) => ({ ladder: s.ladder, text: s.note })));
    expect(sheet.confidenceWhy).toBeTruthy();
  });

  it('the hardware block wraps inside its panel: the 68-character board name and the driver stay in the DOM without a nowrap rule (plan 17a)', () => {
    const page = renderToStaticMarkup(<ScoreSheetView sheet={sheet} />);
    expect(page).toContain('rp-table rp-hardware');
    for (const s of ['MAG X870E TOMAHAWK WIFI', '2.A60', '616.92', 'Windows 11 Home 25H2 build 26200.1234']) expect(page).toContain(s);
    // jsdom cannot measure a table; the stylesheet's rule is what keeps the column inside the panel.
    const css = readFileSync(join(__dirname, '..', 'src', 'report', 'report.css'), 'utf8');
    expect(css).toMatch(/\.rp-hardware td:last-child \{[^}]*white-space: normal;[^}]*overflow-wrap: anywhere;/);
    expect(css).toMatch(/\.rp-panel \{[^}]*min-width: 0;/);
    expect(css).toMatch(/\.rp-grid \{[^}]*minmax\(0, 1fr\) minmax\(0, 1fr\)/);
    expect(css).toMatch(/@media \(max-width: 1000px\) \{ \.rp-grid/);
  });

  it("each ladder's rungs end with the collector's stop sentence, and 'at the certified pair' is not printed when nothing was certified", () => {
    const page = renderToStaticMarkup(<ScoreSheetView sheet={sheet} />);
    for (const s of high.tune.status.result!.stops) expect(page).toContain(s.note);
    expect(page).toContain('>stopped<');
    const none = headroomSheet({ ...high.tune.export, certified: { coreMhz: 0, memMhz: 0 }, score: null, sliderTotal: null }, { ...high.tune.status.result!, certified: { coreMhz: 0, memMhz: 0 }, official: null }, context());
    const nonePage = renderToStaticMarkup(<ScoreSheetView sheet={none} />);
    expect(nonePage).not.toContain('at the certified pair');
    expect(nonePage).toContain('confidence');
    expect(nonePage).toContain('nothing above the card as found held');
  });

  it('an export the earlier collector wrote lists the as-found and official runs among the rungs: the table carries the ladder alone', () => {
    const a = high.tune.export.asFound!;
    const o = high.tune.export.score!;
    const asRung = { ladder: 'memory' as const, deltas: a.deltas, verdict: a.verdict, stage: null, failedPattern: null, held: a.held, topSmMhz: a.topSmMhz, throughputGsps: null, bandwidthGBs: null, throttledFraction: 0.98, note: a.note, score: a.score };
    const dup = headroomSheet({ ...high.tune.export, rungs: [asRung, ...high.tune.export.rungs, { ...asRung, deltas: o.deltas, verdict: o.verdict, held: o.held, note: o.note, score: o.score }] }, high.tune.status.result!, context());
    expect(dup.rungs.length).toBe(9);
    expect(dup.rungs.map((r) => r.offsetMhz)).not.toContain(-2036);
    expect(dup.asFoundPoints).toBe(11701);
  });

  it('the §17 redaction is reused: no serial, PCI instance id, host name or user name anywhere in the file', () => {
    const html = exportReportFile({ kind: 'score', sheet }, TEMPLATE);
    const page = renderToStaticMarkup(<ScoreSheetView sheet={sheet} />);
    // The machine's own names; a name under four characters (the dev box's host name is two) would match inside the logo's base64, so only real names are grepped.
    const names = [os.hostname(), os.userInfo().username, basename(os.homedir())].filter((n) => n.length >= 4);
    expect(names.length).toBeGreaterThan(0);
    for (const out of [html, page, JSON.stringify(sheet)]) {
      expect(out).not.toContain('07E5920');
      expect(out).not.toContain('7E5920&0');
      for (const n of names) expect(out.toLowerCase()).not.toContain(n.toLowerCase());
      expect(out).not.toMatch(/serial\s*(number)?\s*:\s*[A-Z0-9]{6,}/i);
    }
    expect(sheet.hardware.gpu).toContain(REDACTED);
    expect(sheet.rungs[0].note).toContain(`Serial Number: ${REDACTED}`);
    expect(page).toContain('host names and user names are not in this sheet');
  });

  it('renders the score layout top to bottom with the share card, and the one template switches on kind', () => {
    const page = renderToStaticMarkup(<ReportFileView data={{ kind: 'score', sheet }} />);
    // The order people compare in: score and values, rungs, the component tables, hardware and validity, the share card and the export text last.
    const order = ['Comparison sheet', '11,812 points at +45 / +60', '+0.9 % over the card as found', '+18.1 % over a reference RTX 5090', 'type into GPU Tweak / Afterburner', 'on top of your tune, slider units', 'certified on top, NVML MHz', 'Rungs — the score climb', '>GPU<', 'Memory junction', 'Limit reasons', 'SwPowerCap 71 %', '>CPU<', '>RAM<', '6200 MT/s', '>Hardware<', 'Power supply', '1300 W 80 PLUS Platinum', '>Validity<', '<svg', 'Strata Tune headroom score', 'Values and what the card holds', 'Strata Tune 0.1.0'];
    let pos = 0;
    for (const s of order) {
      const i = page.indexOf(s, pos);
      expect(i, s).toBeGreaterThanOrEqual(0);
      pos = i + s.length;
    }
    expect(page).not.toMatch(/https?:\/\//);
    expect(page).not.toMatch(/undefined|NaN/);
    expect(page).toContain('✓');
    expect(page).toContain('—');
    // The stutter report still renders through the same switch.
    const stutter = renderToStaticMarkup(<ReportFileView data={{ report: analyse(benchSession(), '0.1.0').report.report, session: analyse(benchSession(), '0.1.0').report.session }} />);
    expect(stutter).toContain('Bench report');
  });

  it('the file round-trips through the template slot with its kind, and is named by the run', () => {
    const file = { kind: 'score' as const, sheet };
    const html = exportReportFile(file, TEMPLATE);
    expect(html).toContain('"kind":"score"');
    const doc = { getElementById: (id: string) => (id === 'strata-report' ? { textContent: html.slice(html.indexOf('{"kind"'), html.indexOf('</script>', html.indexOf('{"kind"'))) } : null) } as unknown as Document;
    expect(readEmbeddedReport(doc)).toEqual(file);
    expect(reportFileNameOf(file)).toMatch(/^strata-tune-headroom-2026-09-17-\d{4}\.html$/);
    expect(scoreSheetFileName({ run: 'bench', measuredAt: 'nope' })).toBe('strata-tune-bench-undated.html');
  });

  it('a card with nothing certified is the as-found sheet: no values, the score stands as found', () => {
    const none = headroomSheet({ ...high.tune.export, certified: { coreMhz: 0, memMhz: 0 }, score: null, sliderTotal: null }, { ...high.tune.status.result!, certified: { coreMhz: 0, memMhz: 0 }, official: null }, context());
    expect(none.run).toBe('as-found');
    expect(none.certified).toBeNull();
    expect(none.score?.points).toBe(11701);
    const card = renderToStaticMarkup(<HeadroomCard sheet={none} />);
    expect(card).toContain('nothing above the card as found');
    expect(card).toContain('11,701');
  });

  it('a run that ended before its official run is the as-found sheet with the certified pair named as unscored (run 154463d9b2f1)', () => {
    const early = headroomSheet({ ...high.tune.export, certified: { coreMhz: 0, memMhz: 45 }, score: null }, { ...high.tune.status.result!, certified: { coreMhz: 0, memMhz: 45 }, official: null }, context());
    expect(early.run).toBe('as-found');
    const page = renderToStaticMarkup(<ScoreSheetView sheet={early} />);
    expect(page).toContain('11,701 points as found');
    expect(page).not.toContain('11,701 points at');
    expect(page).toContain('The certified pair (+0 / +45) was not scored: the run ended before its official run.');
    expect(renderToStaticMarkup(<HeadroomCard sheet={early} />)).toContain('HEADROOM SCORE · THE CARD AS FOUND');
  });

  it("the built-in bench becomes a sheet with no points, its GPU table from the session's own timeline, and the frame verdict", () => {
    const session = benchSession();
    const report = analyse(session, '0.1.0').report;
    const bench = benchSheet(session, report, { ...context(), snapshot: session.snapshot, gpu: session.snapshot?.gpus[0] });
    expect(bench.run).toBe('bench');
    expect(bench.score).toBeNull();
    expect(bench.telemetry?.gpu?.coreMhz.max).toBeGreaterThan(1000);
    expect(bench.telemetry?.samples).toBe(session.gpuTimeline.length);
    expect(bench.lines[0]).toMatch(/^Bench verdict: /);
    expect(bench.validity.find((v) => v.label === 'Frames')?.text).toMatch(/frames analysed/);
    const page = renderToStaticMarkup(<ScoreSheetView sheet={bench} />);
    expect(page).toContain('No points');
    expect(page).toContain('the bench measures frame pacing, not throughput');
    expect(page).toContain('The bench records the GPU only.');
    expect(page.toLowerCase()).not.toContain(basename(os.homedir()).toLowerCase());
    expect(page).not.toMatch(/undefined|NaN/);
  });
});
