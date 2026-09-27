import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { migrateAcceptance, readAcceptance } from '../electron/legal';

/**
 * The macOS branches of the main process (docs/MACOS.md): where the disclaimer record lives.
 * main.ts imports Electron, so its sources are read, as keep-awake.test.ts does.
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
