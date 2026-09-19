import React from 'react';

interface Props {
  title: string;
  phase: string;
  /** One sentence: what will live on this page, from the master plan. */
  children: React.ReactNode;
}

/** Empty-state frame for every page until its phase ships. */
export const Placeholder: React.FC<Props> = ({ title, phase, children }) => (
  <div className="flex-1 flex items-center justify-center p-8">
    <div className="max-w-xl w-full rounded-lg border border-studio-border bg-studio-panel/50 p-6 space-y-3">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-base font-semibold text-studio-text">{title}</h1>
        <span className="text-micro uppercase tracking-wider text-studio-accent font-semibold shrink-0">{phase}</span>
      </div>
      <p className="text-mini text-studio-muted leading-relaxed">{children}</p>
    </div>
  </div>
);
