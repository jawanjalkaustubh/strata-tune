import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { migrateAcceptance, readAcceptance } from '../electron/legal';

/**
 * The macOS branches of the main process (docs/MACOS.md): where the disclaimer record lives,
 * the application menu, background throttling and the Monitor's sensor lease. main.ts imports
 * Electron, so its sources are read, as keep-awake.test.ts does.
 */
const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('the disclaimer record on macOS', () => {
  it('moves from ~/AppData/Local/Strata Tune to the data folder, removes the emptied folders and never touches a newer record', () => {
    const home = mkdtempSync(join(tmpdir(), 'strata-home-'));
    const oldDir = join(home, 'AppData', 'Local', 'Strata Tune');
    mkdirSync(oldDir, { recursive: true });
    const from = join(oldDir, 'disclaimer.json');
    writeFileSync(from, JSON.stringify({ version: 2, acceptedAt: '2026-09-20T00:00:00Z' }));
    const to = join(home, 'Library', 'Application Support', 'Strata Tune', 'disclaimer.json');
    migrateAcceptance(from, to, home);
    expect(readAcceptance(to)).toEqual({ version: 2, acceptedAt: '2026-09-20T00:00:00Z' });
    expect(existsSync(join(home, 'AppData'))).toBe(false);
    expect(existsSync(home)).toBe(true);
    // A second record under the old path (another build) does not overwrite the one in place.
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(from, JSON.stringify({ version: 1, acceptedAt: 'x' }));
    writeFileSync(join(oldDir, 'other.txt'), 'kept');
    migrateAcceptance(from, to, home);
    expect(readAcceptance(to)?.version).toBe(2);
    expect(existsSync(from)).toBe(true);
  });

  it('main.ts reads it from tuneDataDir() on macOS and keeps the Windows path as it was', () => {
    const main = read('electron/main.ts');
    expect(main).toContain("const acceptance = acceptanceFile(process.platform === 'darwin' ? tuneDataDir() : windowsDataDir);");
    expect(main).toContain("path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Strata Tune')");
    expect(main).toMatch(/if \(process\.platform === 'darwin'\) migrateAcceptance\(/);
  });
});

describe('the main process on macOS', () => {
  const main = read('electron/main.ts');

  it('keeps an app and an Edit menu on macOS (Cmd+C/V/X/A/Z, Cmd+Q) with no View menu, and none on Windows', () => {
    expect(main).toContain("Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }]) : null);");
    expect(main).not.toMatch(/role: '(viewMenu|reload|toggleDevTools|forceReload)'/);
  });

  it('leaves background throttling on for macOS and takes the Monitor\'s sensor lease with the subscription', () => {
    const live = main.slice(main.indexOf('function setLiveSession'), main.indexOf('// ------------------------------------------------------------------- IPC'));
    expect(live).toContain("if (process.platform === 'darwin') return;");
    expect(main).toContain("ticksLease ??= c.lease('monitor');");
    const unsubscribe = main.slice(main.indexOf("ipcMain.on('collector:unsubscribe'"), main.indexOf("c.on('status'"));
    expect(unsubscribe.match(/dropLease\(\)/g)).toHaveLength(2);
  });

  it('holds a page\'s named sensor lease (About → Clocks polls rather than subscribes) and drops it with a reload or a crash reload', () => {
    const handler = main.slice(main.indexOf("ipcMain.on('collector:lease'"), main.indexOf("webContents.on('did-start-loading'"));
    expect(handler).toContain('pageLeases.set(reason, c.lease(reason))');
    expect(handler).toContain('pageLeases.get(reason)?.release();');
    const reload = main.slice(main.indexOf("webContents.on('did-start-loading'"), main.indexOf("c.on('status'"));
    expect(reload).toContain('dropPageLeases();');
    expect(read('electron/preload.cjs')).toContain("lease: (reason, held) => ipcRenderer.send('collector:lease', reason, held)");
  });
});
