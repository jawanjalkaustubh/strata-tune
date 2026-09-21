import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { CollectorClient } from './collector';
import { registerAdvisorIpc } from './bench';
import { registerLlmBenchIpc } from './llm-bench';
import { registerHistoryIpc } from './history';
import { CaptureController, registerCaptureIpc } from './capture';
import { registerTuneIpc } from './tune';
import { legalFilePaths, registerAboutIpc } from './about';
import { acceptanceFile, legalStatus, registerLegalIpc } from './legal';
import { GameMode } from './game-mode';
import type { CollectorState } from '../src/api';
import type { LoadKind, Tick } from '../src/collector-types';

// Strata Tune is a dashboard; nothing on screen needs a GPU. Rendering on the
// CPU is the only way to be sure the monitor never perturbs a stress test or a
// frame capture on the card under test (master plan A6). Must run before ready.
// The STRATA_SELFTEST=1 path below measures the effect of this line and fails
// if it is ever moved or removed.
app.disableHardwareAcceleration();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SELFTEST = (process.env.STRATA_SELFTEST || '').trim() === '1';

let mainWindow: BrowserWindow | null = null;

/** Set in before-quit; consulted before every late spawn and every reload. */
let quitting = false;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------------- boot

/**
 * A boot failure must be visible and must end the process: an unhandled
 * rejection in main is one stderr line nobody sees under the .vbs launcher,
 * and electron.exe would then live on with no window and no exit path
 * (lifecycle audit 2026-09-15, item 20). showErrorBox is safe before ready.
 */
function fatal(stage: string, err: unknown): void {
  const detail = err instanceof Error ? err.stack || err.message : String(err);
  console.error(`[boot] ${stage}:`, detail);
  try {
    dialog.showErrorBox('Strata Tune could not start', `${stage}\n\n${detail}`);
  } catch {
    /* no display: the exit code is the message */
  }
  app.exit(1);
}

// ------------------------------------------------------------------ window

/** Renderer reloads after render-process-gone; past this the app gives up loudly instead of looping. */
const MAX_RENDERER_RESTARTS = 3;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    center: true,
    frame: false,
    // macOS keeps the frameless window's traffic lights; the custom title bar leaves them room and draws no controls of its own (src/components/TitleBar.tsx).
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 12, y: 12 } } : {}),
    title: 'Strata Tune',
    // .ico is Windows-only; macOS takes a PNG here in dev (the .app bundle's icns when packaged).
    icon: path.join(app.getAppPath(), 'assets', process.platform === 'win32' ? 'strata-tune-st.ico' : 'strata-tune-st.png'),
    show: true,
    backgroundColor: '#0c0e14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      // Chromium's default (throttle timers while hidden or occluded, intensively
      // after 5 min) is right for an idle dashboard; setLiveSession(true) lifts
      // it only while a session runs.
      sandbox: true
    }
  });
  const win = mainWindow;
  win.setMenuBarVisibility(false);
  // Links from the renderer (donate, project page) open in the default browser,
  // never in a second Electron window. Only https leaves the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/\S+$/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // A renderer crash would otherwise leave a frameless window with nothing in
  // it and no title bar to close it with. Every reason reloads, 'killed' (End
  // Task on the renderer in Task Manager) included: the dead window is the
  // worse outcome, and the cap is what stops a crash loop.
  let rendererRestarts = 0;
  win.webContents.on('render-process-gone', (_e, details) => {
    if (quitting || win.isDestroyed()) return;
    rendererRestarts += 1;
    console.error(`[renderer] gone (${details.reason}, exit ${details.exitCode}); restart ${rendererRestarts}/${MAX_RENDERER_RESTARTS}`);
    if (rendererRestarts > MAX_RENDERER_RESTARTS) {
      fatal(`The interface crashed ${rendererRestarts} times (${details.reason})`, 'Giving up; run npm start from a terminal to see the console.');
      return;
    }
    win.webContents.reload();
  });

  // The initial load owns its own failure (the promise rejects with the same
  // error did-fail-load reports); did-fail-load handles only later navigations
  // (a Retry reload, a crash reload), main frame only, and not -3 ERR_ABORTED,
  // which is a navigation superseded by another and no error at all.
  let initialLoadSettled = false;
  win.webContents.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3 || !initialLoadSettled || quitting) return;
    fatal('The interface failed to load', `${description} (${code}) ${url}`);
  });

  const load = process.env.VITE_DEV_SERVER_URL
    ? win.loadURL(process.env.VITE_DEV_SERVER_URL)
    : win.loadFile(path.join(__dirname, '../dist/index.html'));
  load.finally(() => (initialLoadSettled = true)).catch((e) => fatal('The interface failed to load', e));

  // Windows logoff / shutdown: before-quit is not emitted (Electron documents
  // it); this is the one place to flush state and tell the collector.
  win.on('session-end', () => void shutdown());
  win.on('closed', () => (mainWindow = null));
}

/**
 * Background throttling is Chromium's default and stays on while the app is a
 * dashboard; a live session (Monitor page at 2 Hz, a capture) must keep its
 * cadence while the game is in front, so it is lifted only then and restored
 * after (lifecycle audit item 34). A tick subscription (the Monitor page) is
 * what turns it on and off, in registerCollectorIpc.
 */
function setLiveSession(on: boolean): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.setBackgroundThrottling(!on);
}

// ------------------------------------------------------------------- IPC

/** support.json at the repo root, read on demand so editing it needs no rebuild. */
function readSupport(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'support.json'), 'utf-8'));
  } catch {
    return {};
  }
}

function registerIpc() {
  ipcMain.on('window:minimize', () => mainWindow?.minimize());
  ipcMain.on('window:maximize', () => (mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize()));
  ipcMain.on('window:close', () => mainWindow?.close());
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('app:support', () => readSupport());
}

// ------------------------------------------------------------- collector

let collector: CollectorClient | null = null;

// 2 Hz ticks cross the IPC bridge only while a page asks for them, so the
// Audit page and an idle app cost nothing. Single window, so a flag suffices;
// a reload of the renderer starts it over unsubscribed.
let ticksWanted = false;

function sendToRenderer(channel: string, payload: CollectorState | Tick) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function registerCollectorIpc(c: CollectorClient) {
  ipcMain.handle('collector:status', () => c.state);
  ipcMain.handle('collector:start', () => c.start());
  ipcMain.handle('collector:snapshot', () => c.snapshot());
  ipcMain.handle('collector:sensorsMeta', () => c.sensorsMeta());
  ipcMain.handle('collector:sensorsLatest', () => c.sensorsLatest());
  ipcMain.handle('collector:sensorsWindow', (_e, seconds: number) => c.sensorsWindow(seconds));
  ipcMain.handle('collector:gpu', () => c.gpu());
  ipcMain.handle('collector:hogs', (_e, seconds: number) => c.hogs(seconds));
  ipcMain.handle('collector:load', (_e, kind: LoadKind, seconds: number) => c.load(kind, seconds));
  ipcMain.handle('collector:cancelLoad', () => c.cancelLoad());
  // A tick subscriber is a live session: the Monitor must keep its 2 Hz while a game is in front.
  ipcMain.on('collector:subscribe', () => {
    ticksWanted = true;
    setLiveSession(true);
  });
  ipcMain.on('collector:unsubscribe', () => {
    ticksWanted = false;
    setLiveSession(false);
  });
  mainWindow?.webContents.on('did-start-loading', () => {
    ticksWanted = false;
    setLiveSession(false);
  });
  c.on('status', (s: CollectorState) => sendToRenderer('collector:status', s));
  c.on('tick', (t: Tick) => {
    if (ticksWanted) sendToRenderer('collector:tick', t);
  });
}

// ----------------------------------------------------------------- capture

let capture: CaptureController | null = null;

/** PresentMon runs in main and Game Mode comes from Strata Video (plan section 11); state and frames are pushed to the window. */
function registerCapture() {
  capture = new CaptureController(() => collector, new GameMode());
  registerCaptureIpc(ipcMain, capture, (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  });
}

// --------------------------------------------------------------- self-test

/**
 * Resolves once Chromium has replaced the placeholder GPU feature table with
 * the measured one. Armed before `ready` so the event cannot be missed; the
 * normal app never waits on it.
 */
const gpuInfoUpdated: Promise<void> | null = SELFTEST
  ? new Promise((resolve) => app.once('gpu-info-update', () => resolve()))
  : null;

/** The "never hang CI" deadline; cleared on the first finish so it cannot print a second line. */
let selfTestDeadline: NodeJS.Timeout | null = null;
let selfTestFinished = false;

/**
 * One JSON line to stdout, flushed, then exit with the given code. First call
 * wins: when the deadline fires, a test that completes in the gap before
 * app.exit lands (the write callback) must not print a second line.
 */
function finishSelfTest(report: Record<string, unknown>, code: number): void {
  if (selfTestFinished) return;
  selfTestFinished = true;
  if (selfTestDeadline) clearTimeout(selfTestDeadline);
  selfTestDeadline = null;
  process.stdout.write(JSON.stringify(report) + '\n', () => app.exit(code));
}

/**
 * The renderer Chromium is actually drawing with, from the complete GPU info
 * (SwiftShader on the software path, the card's name otherwise). Informative
 * only; bounded so a stuck GPU info collector cannot hang the test.
 */
async function activeRenderer(): Promise<string | null> {
  type Info = {
    auxAttributes?: { glRenderer?: string };
    gpuDevice?: Array<{ active?: boolean; deviceString?: string }>;
  };
  try {
    const info = (await Promise.race([app.getGPUInfo('complete'), delay(3000).then(() => null)])) as Info | null;
    if (!info) return null;
    const active = info.gpuDevice?.find((d) => d.active) ?? info.gpuDevice?.[0];
    return info.auxAttributes?.glRenderer ?? active?.deviceString ?? null;
  } catch {
    return null;
  }
}

/**
 * STRATA_SELFTEST=1: measure that the shell really runs with hardware
 * acceleration off, print one JSON line, exit 0 when it does and 1 when it
 * does not. The collector task and CI key on the exit code and the line.
 *
 * It observes rather than asserts. At `ready`, app.getGPUFeatureStatus() is a
 * placeholder that reads the same whether or not disableHardwareAcceleration()
 * was called; Chromium fills in the real table only once a window's compositor
 * has brought up the GPU path, and announces it with `gpu-info-update`. So: a
 * hidden window, about:blank, wait for the event (bounded), settle, then read.
 * Acceleration counts as off only if the event arrived and compositing,
 * rasterization and WebGL all read something other than "enabled" (they read
 * disabled_software / unavailable_software on the SwiftShader path). With the
 * disable call removed the same keys read "enabled" and the test exits 1.
 */
async function runSelfTest(): Promise<void> {
  const started = Date.now();
  const win = new BrowserWindow({
    show: false,
    width: 320,
    height: 240,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }
  });
  await win.loadURL('about:blank');
  const updated = await Promise.race([gpuInfoUpdated!.then(() => true), delay(5000).then(() => false)]);
  await delay(250);
  const status = app.getGPUFeatureStatus() as unknown as Record<string, string | undefined>;
  const renderer = await activeRenderer();

  const off = (key: string) => {
    const v = status[key];
    return typeof v === 'string' && !/^enabled/.test(v);
  };
  const hardwareAccelerationDisabled = updated && off('gpu_compositing') && off('rasterization') && off('webgl');
  const reason = !updated
    ? 'gpu-info-update never arrived; the feature table is still the placeholder'
    : hardwareAccelerationDisabled
      ? null
      : 'gpu_compositing, rasterization or webgl reads enabled';

  // No win.destroy() here: window-all-closed would app.quit() under the
  // stdout flush. app.exit() in finishSelfTest takes the window down.
  finishSelfTest(
    {
      ok: hardwareAccelerationDisabled,
      hardwareAccelerationDisabled,
      ...(reason ? { reason } : {}),
      gpuInfoUpdated: updated,
      renderer,
      gpuFeatureStatus: status,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      elapsedMs: Date.now() - started
    },
    hardwareAccelerationDisabled ? 0 : 1
  );
}

// --------------------------------------------------------------- lifecycle

/**
 * Bounded shutdown (lifecycle audit 2026-09-15, section 2.4 and item 32), in
 * order, every step time-bounded, nothing synchronous that blocks the loop:
 *   1. `quitting` is already set, so nothing spawns after this point;
 *   2. renderer state: nothing to flush yet (settings live in localStorage);
 *   3. the collector: POST /shutdown with the token, 2 s cap. Its own
 *      SYNCHRONIZE watchdog on our pid is what really ends it (an elevated
 *      child cannot be killed from here); this only makes that earlier.
 * Errors are swallowed: quitting wins.
 */
async function shutdown(): Promise<void> {
  // A capture in flight is saved first: its last sensor slice needs the collector still up.
  await capture?.dispose().catch((err) => console.error('[quit] capture save failed:', err));
  const c = collector;
  if (!c) return;
  try {
    await Promise.race([c.shutdown(2000), delay(2000)]);
  } catch (err) {
    console.error('[quit] collector shutdown failed:', err);
  }
}

// One instance (item 19): a second launch focuses the first window instead of
// racing it for the handshake file and the elevated collector. The self-test
// takes no lock so CI can run it beside an open app.
if (!SELFTEST && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app
    .whenReady()
    .then(async () => {
      // macOS in development runs inside the stock Electron bundle: the Dock icon is set here so it never shows Electron's (the packaged .app carries its own icns).
      if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(path.join(app.getAppPath(), 'assets', 'strata-tune-st.png'));
      if (SELFTEST) {
        // Never hang CI: a stuck test reports itself and exits 1.
        selfTestDeadline = setTimeout(() => finishSelfTest({ ok: false, reason: 'self-test timed out' }, 1), 15000);
        try {
          await runSelfTest();
        } catch (e) {
          finishSelfTest({ ok: false, reason: String(e) }, 1);
        }
        return;
      }
      // Frameless window: without this the default menu's accelerators still
      // work (Ctrl+W closes, Ctrl+R reloads mid-session, F11, Ctrl+Shift+I).
      Menu.setApplicationMenu(null);
      registerIpc();
      registerAdvisorIpc(ipcMain, () => collector);
      registerLlmBenchIpc(ipcMain, () => collector, (channel, payload) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
      });
      registerCapture();
      registerHistoryIpc(ipcMain);
      registerAboutIpc(ipcMain, () => collector);
      createWindow();
      // One UAC prompt per app start (plan section 5). A decline is a state the
      // Audit page shows with a Retry, not a failure of the app.
      collector = new CollectorClient();
      registerCollectorIpc(collector);
      registerTuneIpc(ipcMain, collector, (channel, payload) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
      });
      // Plan section 27a, first launch: the collector waits until DISCLAIMER.md's current
      // version has been accepted once (electron/legal.ts keeps the record beside the handshake).
      const disclaimer = legalFilePaths({ isPackaged: app.isPackaged, appPath: app.getAppPath(), resourcesPath: process.resourcesPath }).disclaimer;
      const acceptance = acceptanceFile(path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Strata Tune'));
      const startCollector = () => collector?.start().catch((e) => console.error('[collector] start failed:', e));
      registerLegalIpc(ipcMain, disclaimer, acceptance, startCollector);
      if (legalStatus(disclaimer, acceptance).ok) startCollector();
      else console.log('[legal] the disclaimer has not been accepted for its current version; the collector waits for I understand');
    })
    .catch((e) => fatal('Startup failed', e));

  app.on('before-quit', (e) => {
    if (quitting) return;
    quitting = true;
    e.preventDefault();
    Promise.race([shutdown(), delay(5000)]).finally(() => app.quit());
  });

  app.on('will-quit', () => collector?.armOrphanCheck());
  app.on('window-all-closed', () => app.quit());
}
