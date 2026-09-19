import React from 'react';
import { Activity, Film, BrainCircuit, SlidersHorizontal, type LucideIcon } from 'lucide-react';

/** Pages in the order people need them (master plan section 17): Tune is the home page and holds the audit. */
export type Page = 'tune' | 'monitor' | 'capture' | 'advisor';

interface PageDef {
  id: Page;
  label: string;
  icon: LucideIcon;
}

export const PAGES: PageDef[] = [
  { id: 'tune', label: 'Tune', icon: SlidersHorizontal },
  { id: 'monitor', label: 'Monitor', icon: Activity },
  { id: 'capture', label: 'Capture', icon: Film },
  { id: 'advisor', label: 'AI Models', icon: BrainCircuit }
];

interface Props {
  page: Page;
  onSelect: (p: Page) => void;
  /** Collector state and, while one runs or is armed, the capture's ("Collector: Connected · Capturing game.exe"). */
  status: string;
}

/** No monogram or wordmark here: the title bar already carries them (user, 2026-09-15). The status shortens by content, never by clipping (plan 17a). */
const BottomBarInner: React.FC<Props> = ({ page, onSelect, status }) => (
  <div className="h-9 flex items-center gap-3 px-3 bg-studio-surface border-t border-studio-border text-micro text-studio-subtle shrink-0">
    <span className="min-w-0 whitespace-nowrap">{status}</span>
    <span className="flex-1" />
    <nav className="flex items-center gap-0.5" aria-label="Pages">
      {PAGES.map(({ id, label, icon: Icon }) => {
        const active = id === page;
        return (
          <button
            key={id}
            onClick={() => onSelect(id)}
            className={`inline-flex items-center gap-1.5 px-2.5 h-7 rounded-control text-mini font-medium transition-colors ${
              active ? 'bg-studio-accent/15 text-studio-accent' : 'text-studio-muted hover:text-studio-text hover:bg-studio-panel-hi'
            }`}
            aria-current={active ? 'page' : undefined}
          >
            <Icon size={13} /> {label}
          </button>
        );
      })}
    </nav>
  </div>
);

export const BottomBar = React.memo(BottomBarInner);
