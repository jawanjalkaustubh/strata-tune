/**
 * Where the macOS pieces live. The Swift worker (collector/mac, built by scripts/mac/build-collector.sh)
 * is the Metal bench and the audit's load kernels; macmon (Homebrew) is the sudo-less sensor source.
 * No Electron import here so the collector modules load in vitest.
 */
import * as fs from 'fs';
import * as path from 'path';

export const MAC_WORKER = 'strata-tune-mac-worker';

/** Dev: the SwiftPM release build in the tree. Packaged: resources/collector beside the app, like the Windows binaries. */
export function macWorkerPath(appPath: string, packaged: boolean, resourcesPath: string): string {
  if (packaged) return path.join(resourcesPath, 'collector', MAC_WORKER);
  return path.join(appPath, 'collector', 'mac', '.build', 'release', MAC_WORKER);
}

/** A Finder launch has no Homebrew on PATH, so the two Homebrew prefixes are tried before PATH. Null when macmon is not installed. */
export function macmonPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = ['/opt/homebrew/bin/macmon', '/usr/local/bin/macmon', ...(env.PATH ?? '').split(':').filter(Boolean).map((d) => path.join(d, 'macmon'))];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}
