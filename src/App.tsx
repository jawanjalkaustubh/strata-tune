import React, { useEffect, useState } from 'react';
import { api } from './api';
import { SupportLinks, EMPTY_SUPPORT, loadSupport } from './support';
import { TitleBar } from './components/TitleBar';
import { BottomBar, Page } from './components/BottomBar';
import { AboutModal } from './components/AboutModal';
import { SettingsModal } from './components/SettingsModal';
import { DisclaimerModal } from './components/DisclaimerModal';
import { useCollectorStatus, statusLabel } from './components/useCollectorStatus';
import { captureStatusLabel, useCaptureState } from './components/capture/useCapture';
import { onNavigate, onOpenSettings, resolveTarget } from './components/navigate';
import { Monitor } from './pages/Monitor';
import { Capture } from './pages/Capture';
import { Advisor } from './pages/Advisor';
import { Tune } from './pages/Tune';
import { PageBoundary } from './components/PageBoundary';

/** Tune is the home page (plan 17): the audit on top, the Headroom hunt beneath it behind the settings switch. */
export const HOME: Page = 'tune';

const PAGES: Record<Page, React.FC> = { tune: Tune, monitor: Monitor, capture: Capture, advisor: Advisor };

export const App: React.FC = () => {
  const [page, setPage] = useState<Page>(HOME);
  const [support, setSupport] = useState<SupportLinks>(EMPTY_SUPPORT);
  const [version, setVersion] = useState('');
  const [showAbout, setShowAbout] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  // Plan 27a, first launch: DISCLAIMER.md with one button until its current version is accepted; the collector waits in the main process.
  const [disclaimer, setDisclaimer] = useState<number | null>(null);
  useEffect(() => {
    api?.legal
      .status()
      .then((s) => setDisclaimer(s.ok ? null : s.version))
      .catch(() => setDisclaimer(null));
  }, []);
  const collector = useCollectorStatus();
  const capture = useCaptureState();

  // Cross-page links (the audit's PBO hint into the Monitor page's setting); the page picks up the rest.
  useEffect(() => onNavigate((t) => setPage(resolveTarget(t).page)), []);
  useEffect(() => onOpenSettings(() => setShowSettings(true)), []);

  // Each startup probe advances the splash; the last one dismisses it. The
  // collector handshake is deliberately not on this list: it waits on a UAC
  // prompt the user may leave open, and the pages show its state themselves.
  // A failed probe must NOT dismiss the splash: __splashFail holds it with the
  // message and a Continue control (lifecycle audit 2026-09-15, item 31),
  // otherwise the text is visible for under 0.5 s.
  useEffect(() => {
    const splash = (p: number, text: string) => (window as any).__splash?.(p, text);
    const done = () => setTimeout(() => (window as any).__splashDone?.(), 150);
    const fail = (err: unknown) => (window as any).__splashFail?.(err instanceof Error ? err.message : String(err));
    if (!api) {
      done(); // plain browser: nothing to wait for
      return;
    }
    // The two probes run in parallel and finish in either order, so the step
    // counts completions: the bar never reads 100% / "Ready" while one is
    // still pending (a stalled version() would otherwise sit at "Ready" and
    // the watchdog would report "Still starting… (100%)").
    let finished = 0;
    const advance = () => {
      finished += 1;
      splash(40 + 30 * finished, finished === 2 ? 'Ready' : 'Almost ready…');
    };
    splash(40, 'Reading version and support links…');
    Promise.all([
      api.version().then((v) => {
        setVersion(v);
        advance();
      }),
      loadSupport().then((s) => {
        setSupport(s);
        advance();
      })
    ]).then(done, fail);
  }, []);

  const Current = PAGES[page];

  return (
    <div className="h-full flex flex-col bg-studio-bg text-studio-text">
      <TitleBar support={support} onOpenAbout={() => setShowAbout(true)} onOpenSettings={() => setShowSettings(true)} />
      <main className="flex-1 flex flex-col min-h-0 overflow-auto">
        <PageBoundary page={page}>
          <Current />
        </PageBoundary>
      </main>
      <BottomBar page={page} onSelect={setPage} status={[`Collector: ${statusLabel(collector)}`, captureStatusLabel(capture)].filter(Boolean).join(' · ')} />
      <AboutModal isOpen={showAbout} onClose={() => setShowAbout(false)} version={version} support={support} />
      <SettingsModal isOpen={showSettings} onClose={() => setShowSettings(false)} />
      {disclaimer !== null && <DisclaimerModal version={disclaimer} onAccepted={() => setDisclaimer(null)} />}
    </div>
  );
};
