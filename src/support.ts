import { api } from './api';

/**
 * Project and donation links, from support.json at the repo root. Same shape
 * as Strata Code, Photo and Video. Everything is optional: a component renders
 * its link only when the URL is set, so an empty support.json simply has no
 * donate button. The main process reads the file on request, so filling the
 * URL in later needs no rebuild.
 */
export interface SupportLinks {
  projectUrl: string;
  issuesUrl: string;
  donateUrl: string;
  donateLabel: string;
}

export const EMPTY_SUPPORT: SupportLinks = { projectUrl: '', issuesUrl: '', donateUrl: '', donateLabel: 'Support development' };

const isHttp = (u: unknown): u is string => typeof u === 'string' && /^https:\/\/\S+$/i.test(u);

export function normalizeSupport(raw: Partial<SupportLinks> | null | undefined): SupportLinks {
  const r = raw || {};
  return {
    projectUrl: isHttp(r.projectUrl) ? r.projectUrl : '',
    issuesUrl: isHttp(r.issuesUrl) ? r.issuesUrl : '',
    donateUrl: isHttp(r.donateUrl) ? r.donateUrl : '',
    donateLabel: typeof r.donateLabel === 'string' && r.donateLabel.trim() ? r.donateLabel.trim() : EMPTY_SUPPORT.donateLabel
  };
}

export async function loadSupport(): Promise<SupportLinks> {
  if (!api) return EMPTY_SUPPORT;
  try {
    return normalizeSupport(await api.support());
  } catch {
    return EMPTY_SUPPORT;
  }
}

/** Opens in the default browser: the main window's open handler routes https out of the app. */
export function openExternal(url: string) {
  if (!isHttp(url)) return;
  window.open(url, '_blank', 'noopener');
}
