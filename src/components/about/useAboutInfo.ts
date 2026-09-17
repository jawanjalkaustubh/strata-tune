import { useEffect, useState } from 'react';
import { api, ipcErrorMessage } from '../../api';
import type { AboutSystem, DirectXInfo, LegalTexts } from '../../../electron/about';
import { BUNDLED_LEGAL } from './legalText';

export interface AboutInfo {
  /** Null outside Electron and until the main process answers. */
  system: AboutSystem | null;
  /** 'reading' while dxdiag runs for the first time (about 20 s); null outside Electron or when it failed. */
  directx: DirectXInfo | 'reading' | null;
  legal: LegalTexts | null;
  error: string;
}

/**
 * The hub's facts, fetched each time it opens: the Windows and collector facts are cheap
 * and may have changed (the collector reconnects), the legal texts come from the bundled
 * files, and DirectX is cached by the main process after its one dxdiag run. Outside
 * Electron the legal texts are the build-time copies of the same files, and the system
 * rows say the app is not running.
 */
export function useAboutInfo(isOpen: boolean): AboutInfo {
  const [system, setSystem] = useState<AboutSystem | null>(null);
  const [directx, setDirectx] = useState<DirectXInfo | 'reading' | null>(null);
  const [legal, setLegal] = useState<LegalTexts | null>(api ? null : BUNDLED_LEGAL);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isOpen || !api) return;
    let live = true;
    const a = api.about;
    setError('');
    a.system()
      .then((s) => live && setSystem(s))
      .catch((e) => live && setError(ipcErrorMessage(e)));
    a.legal()
      .then((t) => live && setLegal(t))
      .catch((e) => live && setError(ipcErrorMessage(e)));
    setDirectx((d) => (d && d !== 'reading' ? d : 'reading'));
    a.directx()
      .then((d) => live && setDirectx(d))
      .catch(() => live && setDirectx(null));
    return () => {
      live = false;
    };
  }, [isOpen]);

  return { system, directx, legal, error };
}
