/**
 * First launch (plan section 27a, the first row of the surface table): DISCLAIMER.md is
 * shown in a modal with one button, and the collector does not start until it is pressed.
 * The acceptance is { version, acceptedAt } against the disclaimer's own "Version N" line,
 * so a new version of the text is shown again. The main process keeps the record (the
 * collector is its to start, before any renderer setting is readable); the renderer mirrors
 * it in its settings for the About hub.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { IpcMain } from 'electron';

export interface DisclaimerAcceptance {
  version: number;
  acceptedAt: string;
}

export interface LegalStatus {
  /** The disclaimer's version as its header line says; 0 when the file is missing or unversioned (then nothing is gated). */
  version: number;
  accepted: DisclaimerAcceptance | null;
  /** The text is accepted for the current version: the collector may start. */
  ok: boolean;
}

/** "Version 2 · 2026-09-17 · applies to every build" on the disclaimer's first lines. */
export function disclaimerVersion(markdown: string): number {
  const m = /^Version\s+(\d+)\b/m.exec(markdown);
  return m ? Number(m[1]) : 0;
}

export function acceptanceFile(dataDir: string): string {
  return path.join(dataDir, 'disclaimer.json');
}

export function readAcceptance(file: string): DisclaimerAcceptance | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<DisclaimerAcceptance>;
    return Number.isInteger(parsed.version) && typeof parsed.acceptedAt === 'string' ? { version: parsed.version as number, acceptedAt: parsed.acceptedAt } : null;
  } catch {
    return null;
  }
}

export function writeAcceptance(file: string, acceptance: DisclaimerAcceptance): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(acceptance, null, 2));
}

/** Whether the collector may start: the text's version (from the bundled file) is the one on record. An unversioned or missing file gates nothing. */
export function legalStatus(disclaimerPath: string, file: string): LegalStatus {
  let version = 0;
  try {
    version = disclaimerVersion(fs.readFileSync(disclaimerPath, 'utf8'));
  } catch {
    version = 0;
  }
  const accepted = readAcceptance(file);
  return { version, accepted, ok: version === 0 || accepted?.version === version };
}

/**
 * IPC: 'legal:status' answers the record; 'legal:accept' writes it for the current version and
 * calls `onAccepted` once, which is where the main process starts the collector it held back.
 */
export function registerLegalIpc(ipc: IpcMain, disclaimerPath: string, file: string, onAccepted: () => void): void {
  ipc.handle('legal:status', () => legalStatus(disclaimerPath, file));
  ipc.handle('legal:accept', () => {
    const status = legalStatus(disclaimerPath, file);
    if (!status.ok) {
      writeAcceptance(file, { version: status.version, acceptedAt: new Date().toISOString() });
      onAccepted();
    }
    return legalStatus(disclaimerPath, file);
  });
}
