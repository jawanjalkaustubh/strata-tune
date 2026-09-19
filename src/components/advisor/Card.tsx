import React from 'react';

interface Props {
  title: string;
  /** Right-hand side of the header: the GPU name, the factor, the context length. */
  aside?: React.ReactNode;
  children: React.ReactNode;
}

/** 1 px border, slightly lighter surface, no shadow (plan 17a). The advisor's panels are static, so this stays apart from the Monitor panel's rename and drag handles. */
export const Card: React.FC<Props> = ({ title, aside, children }) => (
  <section className="rounded-md border border-studio-border bg-studio-panel min-w-0">
    <header className="flex items-center justify-between gap-3 px-3 h-8 border-b border-studio-border">
      <h2 className="label text-studio-muted truncate">{title}</h2>
      {aside && <div className="flex items-center gap-2 min-w-0">{aside}</div>}
    </header>
    <div className="p-3 space-y-1.5 min-w-0">{children}</div>
  </section>
);
