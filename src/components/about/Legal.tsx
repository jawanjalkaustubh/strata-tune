import React, { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import type { LegalTexts } from '../../../electron/about';
import { LEGAL_TABS, legalText, type LegalTab } from './legalText';
import { Markdown } from './Markdown';

interface Props {
  /** Null while the main process is still reading the files. */
  texts: LegalTexts | null;
  tab: LegalTab;
  onTab(tab: LegalTab): void;
}

/**
 * About → Legal (plan 27a): Licence, Disclaimer, Third-party notices and Privacy, each the
 * bundled file's own words with a Copy button that puts that text on the clipboard.
 * Privacy is the disclaimer's "Your data stays yours" section on its own.
 */
export const Legal: React.FC<Props> = ({ texts, tab, onTab }) => {
  const [copied, setCopied] = useState(false);
  const text = texts ? legalText(texts, tab) : null;
  const copy = () => {
    if (text === null) return;
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        /* the text is on screen and selectable */
      });
  };
  return (
    <section id="about-legal" className="space-y-2" aria-label="Legal">
      <div className="flex flex-wrap items-center gap-1">
        <span className="label mr-2">Legal</span>
        <div role="tablist" className="flex flex-wrap items-center gap-0.5">
          {LEGAL_TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={t.id === tab}
              className={`btn h-6 px-2 ${t.id === tab ? 'bg-studio-accent/15 text-studio-accent' : ''}`}
              onClick={() => onTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <button className="btn h-6" onClick={copy} disabled={text === null} title="Copy this text">
          {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div key={tab} className="rounded-md border border-studio-border bg-studio-panel/60 px-4 py-3 max-h-64 overflow-y-auto select-text" data-testid={`legal-${tab}`}>
        {text === null ? (
          <p className="text-mini text-studio-subtle">
            {texts === null
              ? 'Reading the bundled file…'
              : `This build is missing the file: ${texts.missing.join(', ') || 'no text was bundled'}.`}
          </p>
        ) : (
          <Markdown text={text} />
        )}
      </div>
      {texts && texts.missing.length > 0 && text !== null && (
        <p className="text-micro text-amber-300">Missing from this build: {texts.missing.join(', ')}</p>
      )}
    </section>
  );
};
