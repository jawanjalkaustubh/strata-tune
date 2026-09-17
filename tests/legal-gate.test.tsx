import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { renderToStaticMarkup } from 'react-dom/server';
import { acceptanceFile, disclaimerVersion, legalStatus, readAcceptance, writeAcceptance } from '../electron/legal';

vi.mock('../src/api', () => ({ api: undefined, inElectron: false, ipcErrorMessage: (e: unknown) => String(e) }));

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k)
};
const { DisclaimerModal } = await import('../src/components/DisclaimerModal');

const DISCLAIMER = join(__dirname, '..', 'DISCLAIMER.md');

/**
 * Plan 27a, first launch: DISCLAIMER.md in a modal with one button, the collector held back
 * until it is pressed, the acceptance kept as { version, acceptedAt } and the modal shown
 * again when the text's version changes.
 */
describe('the first-launch disclaimer gate (electron/legal.ts)', () => {
  it("reads the version off the bundled file's header line", () => {
    expect(disclaimerVersion(readFileSync(DISCLAIMER, 'utf8'))).toBe(2);
    expect(disclaimerVersion('# Title\n\nVersion 7 · 2026-01-01')).toBe(7);
    expect(disclaimerVersion('no version line')).toBe(0);
  });

  it('gates the collector until the current version is on record, and again when the version moves', () => {
    const dir = mkdtempSync(join(tmpdir(), 'strata-legal-'));
    try {
      const file = acceptanceFile(dir);
      expect(file.endsWith('disclaimer.json')).toBe(true);
      expect(legalStatus(DISCLAIMER, file)).toMatchObject({ version: 2, accepted: null, ok: false });
      writeAcceptance(file, { version: 1, acceptedAt: '2026-09-16T10:00:00Z' });
      expect(readAcceptance(file)).toEqual({ version: 1, acceptedAt: '2026-09-16T10:00:00Z' });
      // Version 1 accepted, version 2 on disk: shown again.
      expect(legalStatus(DISCLAIMER, file).ok).toBe(false);
      writeAcceptance(file, { version: 2, acceptedAt: '2026-09-17T10:00:00Z' });
      expect(legalStatus(DISCLAIMER, file)).toMatchObject({ version: 2, ok: true });
      // A corrupt record is no record.
      writeFileSync(file, '{not json');
      expect(readAcceptance(file)).toBeNull();
      // A missing or unversioned text gates nothing rather than locking the app.
      expect(legalStatus(join(dir, 'missing.md'), file).ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the modal is the bundled text verbatim through the Legal renderer, one button, no close", () => {
    const html = renderToStaticMarkup(<DisclaimerModal version={2} onAccepted={() => undefined} />);
    expect(html).toContain('disclaimer v2');
    expect(html).toContain('I understand');
    expect(html).toContain('Hardware risk is real, and it is yours');
    expect(html).toContain('never changes a voltage, a power limit or a fan curve');
    expect(html).toContain('The sensor collector starts once you press the button');
    expect(html).not.toContain('aria-label="Close"');
    expect(html).not.toContain('Not now');
  });
});
