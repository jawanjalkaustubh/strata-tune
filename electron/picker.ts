/**
 * The capture picker's curation (master plan section 11, user request 2026-09-16:
 * "the user should be able to pick any benchmarking tool like Geekbench or games", not
 * "some random processes"). Pure: the process list comes from electron/capture.ts, the
 * tables from src/data/benchmarks.json, and the result is every windowed process sorted
 * into the group the picker shows it in. The built-in bench is not a process and is the
 * renderer's own first entry.
 */
import benchmarks from '../src/data/benchmarks.json';

export interface ProcessInfo {
  pid: number;
  exe: string;
  path: string | null;
  title: string;
}

/** 'detected' is a benchmark or a game the tables recognise; 'other' is every other window worth offering. */
export type PickGroup = 'detected' | 'other';

export interface ProcessPick extends ProcessInfo {
  group: PickGroup;
  /** What put it in the detected group: the benchmark's name, the game library, or the Game Mode allowlist. Null for 'other'. */
  source: string | null;
}

/**
 * Desktop shell, overlays, chat and the launchers' own windows (benchmarks.json): nobody
 * captures these, and they bury the game. Judged before the tables, because a launcher lives
 * in its library's folder and would otherwise head the detected group as a game.
 */
const NOISE = new Set([
  'explorer', 'shellhost', 'shellexperiencehost', 'searchhost', 'searchapp', 'startmenuexperiencehost', 'textinputhost',
  'applicationframehost', 'systemsettings', 'lockapp', 'widgets', 'widgetservice', 'runtimebroker', 'taskmgr',
  'nvidia overlay', 'nvidia app', 'nvidia share', 'nvidia web helper', 'nvcontainer', 'nvdisplay.container', 'discord',
  ...benchmarks.launchers
]);

/** The family's own windows by exe stem, spaces and hyphens aside ("Strata Photo.exe", strata-tune-worker.exe); in dev every app runs as electron.exe and is told apart by its window title. Stratagem is a game. */
const FAMILY = new Set(['stratatune', 'stratatunebench', 'stratatunecollector', 'stratatuneworker', 'strataphoto', 'stratavideo', 'stratacode', 'stratasnap']);

const STORE_SEGMENT = '\\windowsapps\\';

/** A lower-case exe pattern from the table; `*` stands for anything. */
const patternOf = (p: string) => new RegExp(`^${p.toLowerCase().split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);

const BENCHMARKS = benchmarks.benchmarks.map((b) => ({ name: b.name, patterns: b.exes.map(patternOf) }));
const LIBRARIES = benchmarks.libraries.map((l) => ({
  name: l.name,
  segment: l.segment.toLowerCase(),
  // A launcher's or an editor's folder inside the library, which the segment alone would take for a game.
  notUnder: ('notUnder' in l && l.notUnder ? l.notUnder : []).map((n) => n.toLowerCase())
}));
const STORE_PUBLISHERS = benchmarks.storePublishers.map((p) => p.toLowerCase());

const stem = (exe: string) => exe.toLowerCase().replace(/\.exe$/, '');

function isStrataApp(p: ProcessInfo): boolean {
  const exe = stem(p.exe);
  return FAMILY.has(exe.replace(/[\s-]/g, '')) || (exe === 'electron' && /^Strata\b/.test(p.title));
}

/** The publisher segment right after \WindowsApps\, when it is one that ships games. */
function storeGame(path: string): boolean {
  const lower = path.toLowerCase();
  const at = lower.indexOf(STORE_SEGMENT);
  if (at < 0) return false;
  const pkg = lower.slice(at + STORE_SEGMENT.length);
  return STORE_PUBLISHERS.some((pub) => pkg.startsWith(pub));
}

/** The benchmark or game library a process belongs to, or null. The library names the source when both it and the allowlist match. */
export function detect(p: ProcessInfo, allowlist: ReadonlySet<string>): string | null {
  const exe = p.exe.toLowerCase();
  const bench = BENCHMARKS.find((b) => b.patterns.some((re) => re.test(exe)));
  if (bench) return bench.name;
  const lower = (p.path ?? '').toLowerCase();
  const library = LIBRARIES.find((l) => lower.includes(l.segment) && !l.notUnder.some((n) => lower.includes(n)));
  if (library) return library.name;
  if (allowlist.has(stem(p.exe))) return 'Game Mode allowlist';
  return p.path && storeGame(p.path) ? 'Microsoft Store' : null;
}

const byExe = (a: ProcessInfo, b: ProcessInfo) => a.exe.localeCompare(b.exe) || a.pid - b.pid;

/** Detected first, then the rest with the noise gone; each group sorted by exe then pid. */
export function curate(list: ProcessInfo[], allowlist: ReadonlySet<string>): ProcessPick[] {
  const detected: ProcessPick[] = [];
  const other: ProcessPick[] = [];
  for (const p of list) {
    if (isStrataApp(p) || NOISE.has(stem(p.exe))) continue;
    const source = detect(p, allowlist);
    if (source) detected.push({ ...p, group: 'detected', source });
    else other.push({ ...p, group: 'other', source: null });
  }
  return [...detected.sort(byExe), ...other.sort(byExe)];
}
