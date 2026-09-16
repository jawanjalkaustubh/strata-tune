import { app, BrowserWindow, ipcMain, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

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

// ------------------------------------------------------------------ window

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    center: true,
    frame: false,
    title: 'Strata Tune',
    icon: path.join(app.getAppPath(), 'assets', 'strata-tune-st.ico'),
    show: true,
    backgroundColor: '#0c0e14',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
      sandbox: true
    }
  });
  mainWindow.setMenuBarVisibility(false);
  // Links from the renderer (donate, project page) open in the default browser,
  // never in a second Electron window. Only https leaves the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/\S+$/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }
  mainWindow.on('closed', () => (mainWindow = null));
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

// --------------------------------------------------------------- self-test

/**
 * Resolves once Chromium has replaced the placeholder GPU feature table with
 * the measured one. Armed before `ready` so the event cannot be missed; the
 * normal app never waits on it.
 */
const gpuInfoUpdated: Promise<void> | null = SELFTEST
  ? new Promise((resolve) => app.once('gpu-info-update', () => resolve()))
  : null;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One JSON line to stdout, flushed, then exit with the given code. */
function finishSelfTest(report: Record<string, unknown>, code: number): void {
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

app.whenReady().then(async () => {
  if (SELFTEST) {
    // Never hang CI: a stuck test reports itself and exits 1.
    setTimeout(() => finishSelfTest({ ok: false, reason: 'self-test timed out' }, 1), 15000);
    try {
      await runSelfTest();
    } catch (e) {
      finishSelfTest({ ok: false, reason: String(e) }, 1);
    }
    return;
  }
  registerIpc();
  createWindow();
});

app.on('window-all-closed', () => app.quit());
