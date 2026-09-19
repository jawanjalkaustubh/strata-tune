/**
 * The hardware-risk section of DISCLAIMER.md, bundled verbatim at build time (plan section
 * 27a: one source, many surfaces; nothing is retyped into a component). The modal renders
 * it as paragraphs and bullets; the text itself lives beside LICENSE.
 */
import disclaimer from '../../../DISCLAIMER.md?raw';

export type DisclaimerBlock = { kind: 'paragraph' | 'bullet'; text: string };

/** The lines of the "Hardware risk" section, without its heading; empty if the file no longer has one. */
export function hardwareRiskSection(markdown: string = disclaimer): DisclaimerBlock[] {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+\d+\.\s+Hardware risk/i.test(l));
  if (start < 0) return [];
  const blocks: DisclaimerBlock[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: 'paragraph', text: paragraph.join(' ') });
    paragraph = [];
  };
  for (const raw of lines.slice(start + 1)) {
    if (/^##\s/.test(raw)) break;
    const line = raw.trim();
    if (!line) {
      flush();
    } else if (/^-\s+/.test(line)) {
      flush();
      blocks.push({ kind: 'bullet', text: line.replace(/^-\s+/, '') });
    } else if (/^\s+/.test(raw) && blocks.length && blocks[blocks.length - 1].kind === 'bullet' && paragraph.length === 0) {
      blocks[blocks.length - 1].text += ` ${line}`;
    } else {
      paragraph.push(line);
    }
  }
  flush();
  return blocks;
}

/** `**bold**` runs as segments, so the modal can render emphasis without an HTML string. */
export function emphasis(text: string): { bold: boolean; text: string }[] {
  return text
    .split(/(\*\*[^*]+\*\*)/)
    .filter((s) => s.length > 0)
    .map((s) => (s.startsWith('**') && s.endsWith('**') ? { bold: true, text: s.slice(2, -2) } : { bold: false, text: s }));
}
