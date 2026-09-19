/**
 * The Legal block's text handling (plan section 27a: one source, many surfaces). The files
 * arrive verbatim from the main process (electron/about.ts reads the bundled copies) or,
 * outside Electron, from the build-time copies below, which are the same files; nothing
 * here retypes a word. The parser turns their Markdown into blocks the tab renders, and
 * keeps every character of the text: only the markup is styled.
 */
import licenceRaw from '../../../LICENSE?raw';
import disclaimerRaw from '../../../DISCLAIMER.md?raw';
import thirdPartyRaw from '../../../THIRD-PARTY-NOTICES.md?raw';
import type { LegalTexts } from '../../../electron/about';
import { emphasis } from '../tune/disclaimer';

export type LegalTab = 'licence' | 'disclaimer' | 'thirdParty' | 'privacy';

export const LEGAL_TABS: { id: LegalTab; label: string }[] = [
  { id: 'licence', label: 'Licence' },
  { id: 'disclaimer', label: 'Disclaimer' },
  { id: 'thirdParty', label: 'Third-party notices' },
  { id: 'privacy', label: 'Privacy' }
];

/** DISCLAIMER.md's "Your data stays yours" section is the privacy statement (plan 27a). */
export const PRIVACY_SECTION = 6;

/** The build-time copies, for a page rendered outside Electron (a served dist/, the tests). */
export const BUNDLED_LEGAL: LegalTexts = { licence: licenceRaw, disclaimer: disclaimerRaw, thirdParty: thirdPartyRaw, missing: [] };

/** A numbered "## n. …" section of a Markdown file, heading included, up to the next "## " heading; empty when the file has no such section. */
export function sectionOf(markdown: string, n: number): string {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^##\\s+${n}\\.\\s`).test(l));
  if (start < 0) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trim();
}

/** The raw text of a tab: what Copy puts on the clipboard and what the parser renders. */
export function legalText(texts: LegalTexts, tab: LegalTab): string | null {
  switch (tab) {
    case 'licence':
      return texts.licence;
    case 'disclaimer':
      return texts.disclaimer;
    case 'thirdParty':
      return texts.thirdParty;
    case 'privacy':
      return texts.disclaimer === null ? null : sectionOf(texts.disclaimer, PRIVACY_SECTION);
  }
}

export type Inline = { kind: 'text' | 'bold' | 'code'; text: string };

/** `**bold**` (from the tune warning's parser) and `code` spans, as segments. */
export function inline(text: string): Inline[] {
  const out: Inline[] = [];
  for (const e of emphasis(text)) {
    if (e.bold) {
      out.push({ kind: 'bold', text: e.text });
      continue;
    }
    for (const part of e.text.split(/(`[^`]+`)/)) {
      if (!part) continue;
      out.push(part.startsWith('`') && part.endsWith('`') && part.length > 2 ? { kind: 'code', text: part.slice(1, -1) } : { kind: 'text', text: part });
    }
  }
  return out;
}

export type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'bullets'; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'rule' };

const cells = (line: string) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
const isTableRule = (line: string) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);

/**
 * The subset of Markdown the three files use: ATX headings, paragraphs (lines joined with a
 * space), "- " bullets with indented continuation lines, "> " quotes, pipe tables and "---"
 * rules. A plain-text file (LICENSE) is paragraphs alone.
 */
export function parseMarkdown(markdown: string): Block[] {
  const lines = markdown.split(/\r?\n/);
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let bullets: string[] | null = null;
  let quote: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ kind: 'paragraph', text: paragraph.join(' ') });
    paragraph = [];
  };
  const flushBullets = () => {
    if (bullets) blocks.push({ kind: 'bullets', items: bullets });
    bullets = null;
  };
  const flushQuote = () => {
    if (quote.length) blocks.push({ kind: 'quote', text: quote.join(' ') });
    quote = [];
  };
  const flushAll = () => {
    flushParagraph();
    flushBullets();
    flushQuote();
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) {
      flushParagraph();
      flushBullets();
      // A blank quote line ("> ") stays inside the quote; a truly empty line ends it.
      flushQuote();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushAll();
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2].trim() });
      continue;
    }
    if (/^-{3,}$/.test(line)) {
      flushAll();
      blocks.push({ kind: 'rule' });
      continue;
    }
    if (line.startsWith('|') && i + 1 < lines.length && isTableRule(lines[i + 1])) {
      flushAll();
      const header = cells(line);
      const rows: string[][] = [];
      i += 2;
      for (; i < lines.length && lines[i].trim().startsWith('|'); i++) rows.push(cells(lines[i]));
      i -= 1;
      blocks.push({ kind: 'table', header, rows });
      continue;
    }
    if (line.startsWith('>')) {
      flushParagraph();
      flushBullets();
      const text = line.replace(/^>\s?/, '').trim();
      if (text) quote.push(text);
      else if (quote.length) {
        // "> " on its own separates two paragraphs of one quotation.
        blocks.push({ kind: 'quote', text: quote.join(' ') });
        quote = [];
      }
      continue;
    }
    const bullet = /^-\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      flushQuote();
      (bullets ??= []).push(bullet[1]);
      continue;
    }
    if (bullets && /^\s+\S/.test(raw)) {
      bullets[bullets.length - 1] += ` ${line}`;
      continue;
    }
    flushBullets();
    flushQuote();
    paragraph.push(line);
  }
  flushAll();
  return blocks;
}
