import React from 'react';
import { ClipboardCheck, Activity, Film, BrainCircuit, SlidersHorizontal, type LucideIcon } from 'lucide-react';

/** Pages in the order people need them (master plan section 17). */
export type Page = 'audit' | 'monitor' | 'capture' | 'advisor' | 'tune';

interface PageDef {
  id: Page;
  label: string;
  icon: LucideIcon;
}

const PAGES: PageDef[] = [
  { id: 'audit', label: 'Audit', icon: ClipboardCheck },
  { id: 'monitor', label: 'Monitor', icon: Activity },
  { id: 'capture', label: 'Capture', icon: Film },
  { id: 'advisor', label: 'AI Models', icon: BrainCircuit },
  { id: 'tune', label: 'Tune', icon: SlidersHorizontal }
];

interface Props {
  page: Page;
  onSelect: (p: Page) => void;
  /** Tune writes to hardware; it is not offered until the settings flag is on. */
  enableTune: boolean;
  /** Collector state and, while one runs or is armed, the capture's ("Collector: Connected · Capturing game.exe"). */
  status: string;
}

/** No monogram or wordmark here: the title bar already carries them (user, 2026-09-15). */
const BottomBarInner: React.FC<Props> = ({ page, onSelect, enableTune, status }) => (
  <div className="h-9 flex items-center gap-3 px-3 bg-studio-surface border-t border-studio-border text-micro text-studio-subtle shrink-0">
    <span className="truncate">{status}</span>
    <span className="flex-1" />
    <nav className="flex items-center gap-0.5" aria-label="Pages">
      {PAGES.filter((p) => p.id !== 'tune' || enableTune).map(({ id, label, icon: Icon }) => {
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
