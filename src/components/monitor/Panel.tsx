import React, { useEffect, useRef, useState } from 'react';
import { Pencil } from 'lucide-react';
import type { Vendor } from './vendors';
import { updateSettings, useSettings } from '../useSettings';

/** What the Monitor page adds to a panel so it can be moved and resized; absent when a panel renders on its own. */
export interface PanelChrome {
  /** Pointer down on the header (outside its controls) starts a move; on the corner grip, a resize. */
  onMoveStart?: (e: React.PointerEvent) => void;
  onResizeStart?: (e: React.PointerEvent) => void;
  /** The panel being moved, and the one the pointer is over. */
  moving?: boolean;
  target?: boolean;
  /** The user gave the panel a height shorter than its content may be: the body scrolls instead of spilling. */
  fixedHeight?: boolean;
}

interface Props extends PanelChrome {
  /** The device kind, kept as a small tag so a renamed panel still says what it is. */
  kind: string;
  /** The detected device name; the user's own name (settings.panelNames) replaces it. A panel that is not a device has only its kind. */
  title?: string;
  /** Hardware id the rename is keyed by ("/amdcpu/0", "/nvml/0", "/motherboard"); without it the title is fixed. */
  nameKey?: string;
  /** Identity accent (plan 17a): header text and the 1 px left border. Never a state colour. */
  vendor?: Vendor;
  /** Right-hand side of the header: a driver version, a BIOS date, a total. */
  aside?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}

/** The user's name for a panel, or the detected one. Shared with the header strip so both read the same. */
export function panelName(names: Record<string, string> | undefined, key: string | undefined, detected: string): string {
  const own = key ? names?.[key]?.trim() : '';
  return own || detected;
}

const Title: React.FC<{ kind: string; title?: string; nameKey?: string; colour?: string }> = ({ kind, title, nameKey, colour }) => {
  const settings = useSettings();
  const shown = panelName(settings.panelNames, nameKey, title ?? '');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);
  const commit = () => {
    if (!nameKey) return;
    const names = { ...settings.panelNames };
    const next = draft.trim();
    // Empty, or the detected name typed back, drops the override.
    if (next && next !== title) names[nameKey] = next;
    else delete names[nameKey];
    updateSettings({ panelNames: names });
    setEditing(false);
  };
  return (
    <div className="flex items-center gap-2 min-w-0">
      <span className={`label shrink-0 ${title ? 'text-studio-subtle' : 'text-studio-muted'}`}>{kind}</span>
      {editing ? (
        <input
          ref={input}
          className="figure text-[12px] bg-studio-bg border border-studio-border-light rounded px-1.5 h-6 w-64 max-w-full text-studio-text outline-none"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setEditing(false);
          }}
          aria-label={`${kind} panel name`}
        />
      ) : (
        <>
          {shown && (
            <h2 className="label truncate" style={colour ? { color: colour } : undefined} title={shown}>
              {shown}
            </h2>
          )}
          {nameKey && (
            <button
              className="shrink-0 text-studio-subtle hover:text-studio-text opacity-0 group-hover/panel:opacity-100 focus-visible:opacity-100"
              title="Rename this panel"
              aria-label="Rename this panel"
              onClick={() => {
                setDraft(shown);
                setEditing(true);
              }}
            >
              <Pencil size={11} />
            </button>
          )}
        </>
      )}
    </div>
  );
};

/** Grip that resizes the panel from its corner: two diagonal hairlines, visible on hover. */
const Grip: React.FC<{ onPointerDown: (e: React.PointerEvent) => void }> = ({ onPointerDown }) => (
  <button
    className="absolute right-0 bottom-0 w-4 h-4 cursor-nwse-resize opacity-0 group-hover/panel:opacity-100 focus-visible:opacity-100 touch-none"
    title="Drag to resize"
    aria-label="Resize this panel"
    onPointerDown={onPointerDown}
  >
    <svg viewBox="0 0 16 16" className="w-4 h-4 text-studio-subtle" aria-hidden="true">
      <path d="M15 6 6 15M15 11l-4 4" stroke="currentColor" strokeWidth={1} fill="none" />
    </svg>
  </button>
);

/**
 * 1 px border, slightly lighter surface, no shadow (plan 17a); fills its grid cell so
 * paired panels stand level. The header carries the device name (renameable) and, on
 * the Monitor page, is the move handle; the corner grip resizes. Moving and target
 * states are a quiet outline, nothing animates.
 */
export const Panel: React.FC<Props> = ({ kind, title, nameKey, vendor, aside, className = '', onMoveStart, onResizeStart, moving, target, fixedHeight, children }) => {
  const startMove = (e: React.PointerEvent) => {
    if (!onMoveStart || e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button, input, a')) return;
    onMoveStart(e);
  };
  const outline = moving ? 'outline outline-1 outline-studio-accent/70 opacity-70' : target ? 'outline outline-1 outline-studio-accent' : '';
  return (
    <section className={`group/panel relative rounded-md border border-studio-border bg-studio-panel min-w-0 h-full flex flex-col ${outline} ${className}`} style={vendor ? { borderLeftColor: vendor.colour } : undefined}>
      <header
        className={`flex items-center justify-between gap-3 px-3 h-8 border-b border-studio-border shrink-0 ${onMoveStart ? 'cursor-grab touch-none' : ''}`}
        onPointerDown={startMove}
        title={onMoveStart ? 'Drag to move' : undefined}
      >
        <Title kind={kind} title={title} nameKey={nameKey} colour={vendor?.colour} />
        {aside && <div className="flex items-center gap-2 min-w-0 shrink">{aside}</div>}
      </header>
      <div className={`panel-body p-3 space-y-1.5 flex-1 min-w-0 min-h-0 ${fixedHeight ? 'overflow-auto' : ''}`}>{children}</div>
      {onResizeStart && <Grip onPointerDown={onResizeStart} />}
    </section>
  );
};
