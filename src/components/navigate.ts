import type { Page } from './BottomBar';

/** What a page can ask to be opened once it shows: the Monitor page's CPU power-limit setting, or the audit at the top of Tune. */
export type Intent = 'cpu-ppt' | 'audit';

export interface Target {
  /** 'audit' is accepted as a spelling of Tune's top half (plan 17: the Audit page folded into Tune). */
  page: Page | 'audit';
  intent?: Intent;
}

/** The page App shows for a target: an 'audit' target is the Tune page with the audit intent. */
export function resolveTarget(t: Target): { page: Page; intent: Intent | null } {
  if (t.page === 'audit') return { page: 'tune', intent: 'audit' };
  return { page: t.page, intent: t.intent ?? null };
}

const EVENT = 'strata-tune:navigate';
let pending: Intent | null = null;

/** A cross-page link (the audit's PBO hint into the Monitor setting): App switches the page, the page collects the intent when it mounts. */
export function navigate(t: Target) {
  pending = resolveTarget(t).intent;
  window.dispatchEvent(new CustomEvent<Target>(EVENT, { detail: t }));
}

export function onNavigate(cb: (t: Target) => void): () => void {
  const h = (e: Event) => cb((e as CustomEvent<Target>).detail);
  window.addEventListener(EVENT, h);
  return () => window.removeEventListener(EVENT, h);
}

const SETTINGS_EVENT = 'strata-tune:settings';

/** Opens the Settings modal from anywhere (the Headroom-off line's "Turn it on"): App owns the modal and listens. */
export function openSettings() {
  window.dispatchEvent(new CustomEvent(SETTINGS_EVENT));
}

export function onOpenSettings(cb: () => void): () => void {
  window.addEventListener(SETTINGS_EVENT, cb);
  return () => window.removeEventListener(SETTINGS_EVENT, cb);
}

/** The intent left for the page that just mounted, taken once. */
export function takeIntent(): Intent | null {
  const i = pending;
  pending = null;
  return i;
}
