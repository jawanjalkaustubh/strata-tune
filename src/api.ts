import type { SupportLinks } from './support';

/** What electron/preload.cjs exposes as window.strata. Keep the two in step. */
export interface StrataApi {
  version(): Promise<string>;
  support(): Promise<Partial<SupportLinks>>;

  minimize(): void;
  maximize(): void;
  close(): void;
}

declare global {
  interface Window {
    strata?: StrataApi;
  }
}

/** Present only inside Electron. In a plain browser the UI renders but window controls are no-ops. */
export const api: StrataApi | undefined = window.strata;

export const inElectron = !!api;
