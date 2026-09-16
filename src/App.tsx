import React, { useEffect, useState } from 'react';
import { api } from './api';
import { SupportLinks, EMPTY_SUPPORT, loadSupport } from './support';
import { Settings, loadSettings } from './settings';
import { TitleBar } from './components/TitleBar';
import { BottomBar, Page } from './components/BottomBar';
import { AboutModal } from './components/AboutModal';
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

  // Each startup probe advances the splash; the last one dismisses it. There is
  // nothing heavy yet; the collector handshake joins this list in Phase 1.
  useEffect(() => {
    const splash = (p: number, text: string) => (window as any).__splash?.(p, text);
    const done = () => setTimeout(() => (window as any).__splashDone?.(), 150);
    if (!api) {
      done(); // plain browser: nothing to wait for
      return;
    }
    splash(40, 'Reading version…');
    Promise.all([
      api.version().then((v) => {
        setVersion(v);
        splash(70, 'Reading support links…');
      }),
      loadSupport().then((s) => {
        setSupport(s);
        splash(100, 'Ready');
      })
    ]).finally(done);
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
      <BottomBar page={current} onSelect={setPage} enableTune={settings.enableTune} status="No capture" />
      <AboutModal isOpen={showAbout} onClose={() => setShowAbout(false)} version={version} support={support} />
    </div>
  );
};
