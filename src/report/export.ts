import { isScoreReport, type Report, type ReportFile, type ScoreReportFile, type SessionSummary, type StutterReport } from './report-types';
import type { ScoreSheet } from './score-types';

/**
 * One renderer, two outputs (plan §19). The built template (dist-report/
 * report-template.html, everything inlined by vite-plugin-singlefile) carries an
 * empty JSON slot; exporting fills the slot with the report and hands back the
 * whole file. Nothing else changes, so the exported page is byte-for-byte the
 * app's renderer plus the data.
 */
export const REPORT_JSON_ID = 'strata-report';

/** Exactly what report-template.html contains; the build leaves a non-module script alone. */
export const REPORT_SLOT = `<script type="application/json" id="${REPORT_JSON_ID}"></script>`;

/** JSON is not HTML-safe inside a script element: a "</script" in a game name would end it. */
const safeJson = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c');

/** Any report file (a stutter report, or the score sheet by its `kind`) into the built template. */
export function exportReportFile(data: ReportFile, template: string): string {
  if (!template.includes(REPORT_SLOT)) throw new Error('report template has no JSON slot; run npm run build:report');
  return template.replace(REPORT_SLOT, () => `<script type="application/json" id="${REPORT_JSON_ID}">${safeJson(data)}</script>`);
}

export function exportReport(report: StutterReport, session: SessionSummary, template: string): string {
  return exportReportFile({ report, session }, template);
}

/** The slot's content in a rendered page, or null when it is still the empty template. */
export function readEmbeddedReport(doc: Document): ReportFile | null {
  const text = doc.getElementById(REPORT_JSON_ID)?.textContent?.trim();
  if (!text) return null;
  const data = JSON.parse(text) as Partial<Report> & Partial<ScoreReportFile>;
  if (data.kind === 'score') return data.sheet ? (data as ScoreReportFile) : null;
  if (!data.report || !data.session) return null;
  return data as Report;
}

/** "strata-tune-headroom-2026-09-17-0640.html": the run kind and its time. */
export function scoreSheetFileName(sheet: Pick<ScoreSheet, 'run' | 'measuredAt'>): string {
  const d = new Date(sheet.measuredAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = Number.isNaN(d.getTime()) ? 'undated' : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `strata-tune-${sheet.run}-${stamp}.html`;
}

/** The saved file's name for either kind. */
export function reportFileNameOf(data: ReportFile): string {
  return isScoreReport(data) ? scoreSheetFileName(data.sheet) : reportFileName(data.session);
}

/** "strata-tune-cyberpunk2077-2026-09-16-2130.html": the game and the start time, nothing the shell would choke on. */
export function reportFileName(session: SessionSummary): string {
  const game = session.game.replace(/\.exe$/i, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'session';
  const d = new Date(session.startedAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = Number.isNaN(d.getTime()) ? 'undated' : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `strata-tune-${game}-${stamp}.html`;
}
