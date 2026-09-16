import React, { useEffect, useState } from 'react';
import { api } from './api';
import { SupportLinks, EMPTY_SUPPORT, loadSupport } from './support';
import { Settings, loadSettings } from './settings';
import { TitleBar } from './components/TitleBar';
import { BottomBar, Page } from './components/BottomBar';
import { AboutModal } from './components/AboutModal';
import { useCollectorStatus, statusLabel } from './components/useCollectorStatus';
import { Audit } from './pages/Audit';
import { Monitor } from './pages/Monitor';
import { Capture } from './pages/Capture';
import { Advisor } from './pages/Advisor';
import { Tune } from './pages/Tune';

const PAGES: Record<Page, React.FC> = { audit: Audit, monitor: Monitor, capture: Capture, advisor: Advisor, tune: Tune };

export const App: React.FC = () => {
  const [page, setPage] = useState<Page>('audit');
  const [settings] = useState<Settings>(loadSettings);
  const [support, setSupport] = useState<SupportLinks>(EMPTY_SUPPORT);
  const [version, setVersion] = useState('');
  const [showAbout, setShowAbout] = useState(false);
  const collector = useCollectorStatus();

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

  // A hidden page cannot stay selected if the flag is turned off between launches.
  const current: Page = page === 'tune' && !settings.enableTune ? 'audit' : page;
  const Current = PAGES[current];

  return (
    <div className="h-full flex flex-col bg-studio-bg text-studio-text">
      <TitleBar support={support} onOpenAbout={() => setShowAbout(true)} />
      <main className="flex-1 flex flex-col min-h-0 overflow-auto">
        <Current />
      </main>
      <BottomBar page={current} onSelect={setPage} enableTune={settings.enableTune} status={`Collector: ${statusLabel(collector)}`} />
      <AboutModal isOpen={showAbout} onClose={() => setShowAbout(false)} version={version} support={support} />
    </div>
  );
};
