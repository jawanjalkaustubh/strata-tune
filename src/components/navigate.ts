import type { Page } from './BottomBar';

/** What a page can ask to be opened once it shows: the Monitor page's CPU power-limit setting. */
export type Intent = 'cpu-ppt';

export interface Target {
  page: Page;
  intent?: Intent;
}

const EVENT = 'strata-tune:navigate';
let pending: Intent | null = null;

/** A cross-page link (the audit's PBO hint into the Monitor setting): App switches the page, the page collects the intent when it mounts. */
export function navigate(t: Target) {
  pending = t.intent ?? null;
  window.dispatchEvent(new CustomEvent<Target>(EVENT, { detail: t }));
}

export function onNavigate(cb: (t: Target) => void): () => void {
  const h = (e: Event) => cb((e as CustomEvent<Target>).detail);
  window.addEventListener(EVENT, h);
  return () => window.removeEventListener(EVENT, h);
}

/** The intent left for the page that just mounted, taken once. */
export function takeIntent(): Intent | null {
  const i = pending;
  pending = null;
  return i;
}
