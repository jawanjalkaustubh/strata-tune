import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as path from 'path';
import { legalFilePaths, readLegal } from '../electron/about';
import { Legal } from '../src/components/about/Legal';
import { LEGAL_TABS, legalText, type LegalTab } from '../src/components/about/legalText';
import { AboutModal } from '../src/components/AboutModal';
import { EMPTY_SUPPORT } from '../src/support';

// Rendered outside Electron: no window.strata, so the hub's legal texts are the build-time copies of the same files.
vi.mock('../src/api', () => ({ api: undefined, inElectron: false, ipcErrorMessage: (e: unknown) => String(e) }));

const ROOT = path.resolve(__dirname, '..');
const texts = readLegal(legalFilePaths({ isPackaged: false, appPath: ROOT, resourcesPath: '' }));

/** The markup's text content, with React's escapes undone, so file lines can be looked for verbatim. */
const textOf = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/** Every non-empty line of the file, its Markdown markers stripped, as the reader should find it. */
function expectFileInMarkup(file: string, markup: string) {
  const text = textOf(markup);
  for (const raw of file.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^\|?\s*:?-{3,}/.test(line)) continue;
    const pieces = line.startsWith('|') ? line.replace(/^\||\|$/g, '').split('|') : [line];
    for (const piece of pieces) {
      const plain = piece.replace(/^#+\s+|^-\s+|^>\s?/, '').replace(/\*\*/g, '').replace(/`/g, '').trim();
      if (plain) expect(text, `missing: ${plain}`).toContain(plain);
    }
  }
}

describe('About → Legal renders the bundled files verbatim (plan 27a)', () => {
  it.each(LEGAL_TABS.map((t) => t.id))('the %s tab shows every line of its file and offers Copy', (tab: LegalTab) => {
    const markup = renderToStaticMarkup(<Legal texts={texts} tab={tab} onTab={() => {}} />);
    const file = legalText(texts, tab);
    expect(file).not.toBeNull();
    expectFileInMarkup(file as string, markup);
    expect(markup).toContain(`data-testid="legal-${tab}"`);
    expect(markup).toContain('Copy');
    expect(markup).toContain('aria-selected="true"');
  });

  it('the Privacy tab is section 6 alone: no hardware-risk or donation wording', () => {
    const markup = textOf(renderToStaticMarkup(<Legal texts={texts} tab="privacy" onTab={() => {}} />));
    expect(markup).toContain('Your data stays yours');
    expect(markup).toContain('no telemetry');
    expect(markup).not.toContain('Hardware risk is real');
    expect(markup).not.toContain('Donations are voluntary');
  });

  it('a missing file says so by path instead of rendering nothing', () => {
    const markup = renderToStaticMarkup(<Legal texts={{ ...texts, disclaimer: null, missing: ['C:\build\resources\DISCLAIMER.md'] }} tab="disclaimer" onTab={() => {}} />);
    expect(textOf(markup)).toContain('This build is missing the file: C:\build\resources\DISCLAIMER.md');
    const loading = renderToStaticMarkup(<Legal texts={null} tab="licence" onTab={() => {}} />);
    expect(loading).toContain('Reading the bundled file');
  });
});

describe('About hub (plan 17)', () => {
  it('renders the facts, every tool, the legal tabs and the licence text outside Electron', () => {
    const markup = renderToStaticMarkup(<AboutModal isOpen onClose={() => {}} version="0.1.0" support={EMPTY_SUPPORT} />);
    const text = textOf(markup);
    for (const s of ['v0.1.0', 'Kaustubh Jawanjal', 'MIT', 'Windows', 'DirectX', 'GPU driver', 'Collector', 'PawnIO', 'HWiNFO bridge']) expect(text).toContain(s);
    for (const tool of ['Save system report (.txt)', 'Save system report (.html)', 'Clocks', 'Timers', 'Validation', 'Copy hardware summary', 'Open logs folder']) expect(text).toContain(tool);
    for (const tab of ['Licence', 'Disclaimer', 'Third-party notices', 'Privacy']) expect(text).toContain(tab);
    expect(text).toContain('Copyright (c) 2026 Kaustubh Jawanjal');
    // No donate button without a URL, and no clipped label: every tool label wraps.
    expect(text).not.toContain('Support development');
    expect(markup).not.toContain('truncate');
  });

  it('is nothing while closed', () => {
    expect(renderToStaticMarkup(<AboutModal isOpen={false} onClose={() => {}} version="0.1.0" support={EMPTY_SUPPORT} />)).toBe('');
  });
});
