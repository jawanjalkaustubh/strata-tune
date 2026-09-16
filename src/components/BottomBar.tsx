import React from 'react';
import { ClipboardCheck, Activity, Film, BrainCircuit, SlidersHorizontal, type LucideIcon } from 'lucide-react';
import { Monogram } from './Monogram';

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
  /** Session / capture state, e.g. "No capture" or "Capturing cyberpunk2077 · 01:12". */
  status: string;
}

const BottomBarInner: React.FC<Props> = ({ page, onSelect, enableTune, status }) => (
  <div className="h-9 flex items-center gap-3 px-3 bg-studio-surface border-t border-studio-border text-micro text-studio-subtle shrink-0">
    <span className="flex items-center gap-2 shrink-0">
      <Monogram size={16} />
      <span className="font-bold tracking-[0.12em] text-studio-muted">STRATA TUNE</span>
    </span>
    <span className="w-px h-3.5 bg-studio-border shrink-0" />
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
