/**
 * Main-process side of the About hub (master plan section 17 'About', 27a 'About → Legal'):
 * the facts about this Windows install the renderer cannot read itself, the bundled legal
 * texts, the collector's timer probe, a save dialog for the tools' files and the logs
 * folder. Everything here reads; the one process it starts is dxdiag, once, for the
 * DirectX feature level.
 */
import { app, BrowserWindow, dialog, shell, type IpcMain, type IpcMainInvokeEvent } from 'electron';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CollectorClient } from './collector';
import type { CollectorState } from '../src/api';
import type { Health, Timers } from '../src/collector-types';
import { tuneDataDir } from './presence';

// ------------------------------------------------------------------ legal

export type LegalFile = 'licence' | 'disclaimer' | 'thirdParty';

/** The three files' names in the repo root, which is also their name beside the packaged app's resources. */
export const LEGAL_FILE_NAMES: Record<LegalFile, string> = { licence: 'LICENSE', disclaimer: 'DISCLAIMER.md', thirdParty: 'THIRD-PARTY-NOTICES.md' };

export interface LegalEnv {
  isPackaged: boolean;
  /** app.getAppPath(): the repo root in dev, the asar in a package. */
  appPath: string;
  /** process.resourcesPath: where electron-builder's extraResources land. */
  resourcesPath: string;
}

/**
 * One resolver for both layouts (plan 27a: the texts live beside LICENSE and are bundled
 * verbatim): the repo root while developing, the resources folder once packaged, where the
 * build copies them as extraResources. Nothing is retyped into a component.
 */
export function legalFilePaths(env: LegalEnv): Record<LegalFile, string> {
  const root = env.isPackaged ? env.resourcesPath : env.appPath;
  return { licence: path.join(root, LEGAL_FILE_NAMES.licence), disclaimer: path.join(root, LEGAL_FILE_NAMES.disclaimer), thirdParty: path.join(root, LEGAL_FILE_NAMES.thirdParty) };
}

export interface LegalTexts {
  licence: string | null;
  disclaimer: string | null;
  thirdParty: string | null;
  /** Files the build is missing, by path, so the tab can say so instead of showing nothing. */
  missing: string[];
}

export function readLegal(paths: Record<LegalFile, string>): LegalTexts {
  const missing: string[] = [];
  const read = (p: string): string | null => {
    try {
      return fs.readFileSync(p, 'utf-8');
    } catch {
      missing.push(p);
      return null;
    }
  };
  return { licence: read(paths.licence), disclaimer: read(paths.disclaimer), thirdParty: read(paths.thirdParty), missing };
}

// ---------------------------------------------------------------- windows

export interface WindowsInfo {
  /** "Windows 11 Home". */
  name: string;
  /** The Settings-page version, "25H2"; empty on builds without DisplayVersion. */
  displayVersion: string;
  /** "26200.1234": the build with its update revision. */
  build: string;
}

/**
 * Marketing names for the registry's EditionID. ProductName is not used for the name: on
 * Windows 11 it still reads "Windows 10 ..." (a known quirk), so the build number decides
 * between 10 and 11 and the edition id names the edition.
 */
const EDITIONS: Record<string, string> = {
  Core: 'Home', CoreN: 'Home N', CoreSingleLanguage: 'Home Single Language', CoreCountrySpecific: 'Home China',
  Professional: 'Pro', ProfessionalN: 'Pro N', ProfessionalEducation: 'Pro Education', ProfessionalWorkstation: 'Pro for Workstations',
  Enterprise: 'Enterprise', EnterpriseN: 'Enterprise N', EnterpriseS: 'Enterprise LTSC', EnterpriseSN: 'Enterprise LTSC N',
  Education: 'Education', EducationN: 'Education N', IoTEnterprise: 'IoT Enterprise', IoTEnterpriseS: 'IoT Enterprise LTSC',
  ServerStandard: 'Server Standard', ServerDatacenter: 'Server Datacenter'
};
const WINDOWS_11_FIRST_BUILD = 22000;

/** `reg query` prints "    Name    REG_SZ    value" lines; REG_DWORD values are hex ("0x4d2"). */
export function parseRegQuery(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s{2,}(\S+)\s+(REG_[A-Z_]+)\s+(.*)$/.exec(line);
    if (!m) continue;
    values[m[1]] = m[2] === 'REG_DWORD' ? String(parseInt(m[3], 16)) : m[3].trim();
  }
  return values;
}

export function describeWindows(reg: Record<string, string>, release: string): WindowsInfo {
  const build = parseInt(reg.CurrentBuild ?? reg.CurrentBuildNumber ?? release.split('.')[2] ?? '', 10);
  const edition = EDITIONS[reg.EditionID ?? ''] ?? reg.EditionID ?? '';
  const family = Number.isFinite(build) ? (build >= WINDOWS_11_FIRST_BUILD ? 'Windows 11' : 'Windows 10') : reg.ProductName ?? 'Windows';
  const ubr = reg.UBR ? `.${reg.UBR}` : '';
  return {
    name: [family, edition].filter(Boolean).join(' '),
    displayVersion: reg.DisplayVersion ?? '',
    build: Number.isFinite(build) ? `${build}${ubr}` : release
  };
}

const CURRENT_VERSION_KEY = 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion';

function run(exe: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(exe, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

const system32 = (exe: string) => path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', exe);

async function windowsInfo(): Promise<WindowsInfo> {
  try {
    return describeWindows(parseRegQuery(await run(system32('reg.exe'), ['query', CURRENT_VERSION_KEY], 5000)), os.release());
  } catch {
    return describeWindows({}, os.release());
  }
}

// ---------------------------------------------------------------- directx

export interface DisplayDevice {
  name: string;
  /** WDDM driver version as dxdiag prints it, "32.0.16.1692"; empty when unknown. */
  driverVersion: string;
  /** "WDDM 3.2". */
  driverModel: string;
  /** "12_2", "12_1", … as the driver reports them. */
  featureLevels: string[];
}

export interface DirectXInfo {
  /** "DirectX 12". */
  version: string;
  devices: DisplayDevice[];
  /** When dxdiag was run; the result is kept per Windows build for a month. */
  readAt: string;
  release: string;
}

/** The lines the About hub needs from `dxdiag /t`: one block per "Card name:" under Display Devices. */
export function parseDxdiag(text: string): Pick<DirectXInfo, 'version' | 'devices'> {
  let version = '';
  const devices: DisplayDevice[] = [];
  let card: DisplayDevice | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z][A-Za-z ]+):\s*(.*)$/.exec(raw);
    if (!m) continue;
    const [, key, value] = m;
    switch (key.trim()) {
      case 'DirectX Version':
        version = value.trim();
        break;
      case 'Card name':
        card = { name: value.trim(), driverVersion: '', driverModel: '', featureLevels: [] };
        devices.push(card);
        break;
      case 'Driver Version':
        if (card && !card.driverVersion && !/^unknown$/i.test(value.trim())) card.driverVersion = value.trim();
        break;
      case 'Driver Model':
        if (card) card.driverModel = value.trim();
        break;
      case 'Feature Levels':
        if (card) card.featureLevels = value.split(',').map((s) => s.trim()).filter((s) => /^\d+_\d+/.test(s));
        break;
    }
  }
  return { version, devices: devices.filter((d) => d.name && !/^unknown$/i.test(d.name)) };
}

const DXDIAG_CACHE = () => path.join(app.getPath('userData'), 'dxdiag.json');
const DXDIAG_MAX_AGE_MS = 30 * 86_400_000;
/** dxdiag enumerates every device and takes 20 s on the dev box; it is run once per Windows build and month. */
const DXDIAG_TIMEOUT_MS = 90_000;

function readDxdiagCache(): DirectXInfo | null {
  try {
    const cached = JSON.parse(fs.readFileSync(DXDIAG_CACHE(), 'utf-8')) as DirectXInfo;
    if (cached.release !== os.release() || Date.now() - Date.parse(cached.readAt) > DXDIAG_MAX_AGE_MS) return null;
    return cached;
  } catch {
    return null;
  }
}

let dxdiagRun: Promise<DirectXInfo> | null = null;

/** The cached answer when there is one; otherwise dxdiag runs once (a second caller joins the same run). */
function directX(): Promise<DirectXInfo> {
  const cached = readDxdiagCache();
  if (cached) return Promise.resolve(cached);
  if (!dxdiagRun) {
    dxdiagRun = (async () => {
      const out = path.join(os.tmpdir(), `strata-tune-dxdiag-${process.pid}.txt`);
      try {
        await run(system32('dxdiag.exe'), ['/whql:off', '/t', out], DXDIAG_TIMEOUT_MS);
        const info: DirectXInfo = { ...parseDxdiag(fs.readFileSync(out, 'utf-8')), readAt: new Date().toISOString(), release: os.release() };
        fs.mkdirSync(path.dirname(DXDIAG_CACHE()), { recursive: true });
        fs.writeFileSync(DXDIAG_CACHE(), JSON.stringify(info));
        return info;
      } finally {
        fs.rmSync(out, { force: true });
        dxdiagRun = null;
      }
    })();
  }
  return dxdiagRun;
}

// ----------------------------------------------------------------- hwinfo

const HWINFO_IMAGE = 'HWiNFO64.exe';

/** Plan 9b's bridge is not built yet; the hub still says whether HWiNFO is running, because that is the first thing the bridge will need. */
async function hwinfoRunning(): Promise<boolean> {
  try {
    const out = await run(system32('tasklist.exe'), ['/FI', `IMAGENAME eq ${HWINFO_IMAGE}`, '/FO', 'CSV', '/NH'], 5000);
    return new RegExp(`^"${HWINFO_IMAGE}"`, 'im').test(out);
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------- system

/** Where the collector writes (mirrors electron/collector.ts): the logs folder the hub opens. */
const dataDir = () => tuneDataDir();
const logsDir = () => path.join(dataDir(), 'logs');

export interface AboutSystem {
  windows: WindowsInfo;
  hwinfoRunning: boolean;
  logsFolder: string;
  dataFolder: string;
  electron: string;
  chrome: string;
  collector: CollectorState;
  /** GET /health while connected, else null. */
  health: Health | null;
}

// ------------------------------------------------------------------- save

export interface SaveFileRequest {
  title: string;
  defaultName: string;
  filters: { name: string; extensions: string[] }[];
  /** Text is written as UTF-8; `base64` as bytes (the share card's PNG). */
  text?: string;
  base64?: string;
}

async function saveFile(e: IpcMainInvokeEvent, req: SaveFileRequest): Promise<string | null> {
  const win = BrowserWindow.fromWebContents(e.sender);
  const options = { title: req.title, defaultPath: path.join(app.getPath('downloads'), req.defaultName), filters: req.filters };
  const r = await (win ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options));
  if (r.canceled || !r.filePath) return null;
  if (req.base64 !== undefined) fs.writeFileSync(r.filePath, Buffer.from(req.base64, 'base64'));
  else fs.writeFileSync(r.filePath, req.text ?? '', 'utf-8');
  return r.filePath;
}

// -------------------------------------------------------------------- IPC

/** The trace runs for a few seconds plus powercfg's analysis; the read alone is instant. */
const TIMERS_TRACE_TIMEOUT_MS = 120_000;

export function registerAboutIpc(ipc: IpcMain, getCollector: () => CollectorClient | null): void {
  ipc.handle('about:system', async (): Promise<AboutSystem> => {
    const c = getCollector();
    const [windows, hwinfo, health] = await Promise.all([
      windowsInfo(),
      hwinfoRunning(),
      c && c.state.status === 'connected' ? c.get<Health>('/health').catch(() => null) : Promise.resolve(null)
    ]);
    return {
      windows, hwinfoRunning: hwinfo, logsFolder: logsDir(), dataFolder: dataDir(),
      electron: process.versions.electron, chrome: process.versions.chrome,
      collector: c?.state ?? { status: 'idle', message: 'Collector not started' }, health
    };
  });
  ipc.handle('about:directx', () => directX());
  ipc.handle('about:legal', () => readLegal(legalFilePaths({ isPackaged: app.isPackaged, appPath: app.getAppPath(), resourcesPath: process.resourcesPath })));
  ipc.handle('about:timers', (_e, traceSeconds?: number) => {
    const c = getCollector();
    if (!c) throw new Error('The collector is not running');
    const trace = Number.isInteger(traceSeconds) && (traceSeconds as number) > 0 ? `?trace=${traceSeconds}&excludePid=${process.pid}` : '';
    return c.get<Timers>(`/timers${trace}`, trace ? TIMERS_TRACE_TIMEOUT_MS : 10_000);
  });
  ipc.handle('about:saveFile', (e, req: SaveFileRequest) => saveFile(e, req));
  ipc.handle('about:openLogs', async () => {
    fs.mkdirSync(logsDir(), { recursive: true });
    const problem = await shell.openPath(logsDir());
    if (problem) throw new Error(problem);
  });
}
