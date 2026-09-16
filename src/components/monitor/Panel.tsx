import React from 'react';
import type { Vendor } from './vendors';

interface Props {
  title: string;
  /** Identity accent (plan 17a): header text and the 1 px left border. Never a state colour. */
  vendor?: Vendor;
  /** Right-hand side of the header: a driver version, a BIOS date, a total. */
  aside?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}

/** 1 px border, slightly lighter surface, no shadow (plan 17a); fills its grid cell so paired panels stand level. */
export const Panel: React.FC<Props> = ({ title, vendor, aside, className = '', children }) => (
  <section className={`rounded-md border border-studio-border bg-studio-panel min-w-0 h-full flex flex-col ${className}`} style={vendor ? { borderLeftColor: vendor.colour } : undefined}>
    <header className="flex items-center justify-between gap-3 px-3 h-8 border-b border-studio-border">
      <h2 className="label text-studio-muted" style={vendor ? { color: vendor.colour } : undefined} title={vendor?.vendor || undefined}>
        {title}
      </h2>
      {aside && <div className="flex items-center gap-2 min-w-0">{aside}</div>}
    </header>
    <div className="p-3 space-y-1.5 flex-1 min-w-0">{children}</div>
  </section>
);
