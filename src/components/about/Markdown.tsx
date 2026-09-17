import React from 'react';
import { inline, parseMarkdown, type Block } from './legalText';

const Inline: React.FC<{ text: string }> = ({ text }) => (
  <>
    {inline(text).map((s, i) =>
      s.kind === 'bold' ? (
        <strong key={i} className="text-studio-text font-medium">
          {s.text}
        </strong>
      ) : s.kind === 'code' ? (
        <code key={i} className="figure text-[11px] text-studio-text bg-studio-panel-hi px-1 rounded">
          {s.text}
        </code>
      ) : (
        <React.Fragment key={i}>{s.text}</React.Fragment>
      )
    )}
  </>
);

const HEADING_CLASS: Record<number, string> = {
  1: 'text-sm font-semibold text-studio-text',
  2: 'text-mini font-semibold text-studio-text pt-1',
  3: 'label text-studio-text pt-1'
};

const BlockView: React.FC<{ block: Block }> = ({ block }) => {
  switch (block.kind) {
    case 'heading':
      return <div className={HEADING_CLASS[Math.min(block.level, 3)]}>{block.text}</div>;
    case 'paragraph':
      return (
        <p>
          <Inline text={block.text} />
        </p>
      );
    case 'bullets':
      return (
        <ul className="space-y-1">
          {block.items.map((item, i) => (
            <li key={i} className="pl-4 relative before:content-['•'] before:absolute before:left-0">
              <Inline text={item} />
            </li>
          ))}
        </ul>
      );
    case 'quote':
      return (
        <blockquote className="border-l-2 border-studio-border-light pl-3 text-studio-subtle">
          <Inline text={block.text} />
        </blockquote>
      );
    case 'table':
      return (
        <table className="w-full text-micro border-collapse">
          <thead>
            <tr>
              {block.header.map((h, i) => (
                <th key={i} className="text-left align-top label py-1 pr-3 border-b border-studio-border font-medium">
                  <Inline text={h} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, r) => (
              <tr key={r} className="align-top">
                {row.map((cell, c) => (
                  <td key={c} className="py-1 pr-3 border-b border-studio-border/60">
                    <Inline text={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    case 'rule':
      return <hr className="border-studio-border" />;
  }
};

/** A legal file as the tab shows it: the file's own words, with its headings, bullets, quotes and tables styled and nothing shortened. */
export const Markdown: React.FC<{ text: string }> = ({ text }) => (
  <div className="space-y-2.5 text-mini text-studio-muted leading-relaxed break-words">
    {parseMarkdown(text).map((b, i) => (
      <BlockView key={i} block={b} />
    ))}
  </div>
);
