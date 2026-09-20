import React from 'react';
import type { AboutSystem, DirectXInfo } from '../../../electron/about';
import { inElectron, type CollectorState } from '../../api';
import { statusLabel } from '../useCollectorStatus';

export const AUTHOR = 'Kaustubh Jawanjal';

interface Props {
  version: string;
  system: AboutSystem | null;
  directx: DirectXInfo | 'reading' | null;
  collector: CollectorState;
  onLegal(): void;
}

const NOT_IN_APP = 'available inside the app';
/** The main window's open handler routes https out of the app. */
const PAWNIO_URL = 'https://pawnio.eu';

const Row: React.FC<{ label: string; children: React.ReactNode; title?: string }> = ({ label, children, title }) => (
  <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 py-1 border-b border-studio-border/60 last:border-b-0" title={title}>
    <span className="label leading-5">{label}</span>
    <span className="text-mini text-studio-text leading-5 break-words">{children}</span>
  </div>
);

const uptime = (s: number) => (s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);

/** The DirectX row: the version Windows reports and the first card's feature level and driver model, from dxdiag's one run. */
export function directXLine(d: DirectXInfo | 'reading' | null): string {
  if (d === 'reading') return 'reading with dxdiag (about 20 s)…';
  if (!d) return inElectron ? 'not read (dxdiag did not answer)' : NOT_IN_APP;
  const card = d.devices.find((x) => x.featureLevels.length) ?? d.devices[0];
  const level = card?.featureLevels[0] ? ` · feature level ${card.featureLevels[0]}` : '';
  const model = card?.driverModel ? ` · ${card.driverModel}` : '';
  return `${d.version || 'DirectX'}${level}${model}`;
}

/** The CPU-Z block (plan 17): version, author, licence and the facts of this install, none of them clipped. */
export const Facts: React.FC<Props> = ({ version, system, directx, collector, onLegal }) => {
  const h = system?.health ?? null;
  const w = system?.windows;
  const nvmlDriver = h?.nvml.driver ?? null;
  const dxDriver = directx && directx !== 'reading' ? directx.devices.find((d) => d.driverVersion)?.driverVersion ?? null : null;
  return (
    <div className="grid gap-x-6 gap-y-3 md:grid-cols-2">
      <div>
        <div className="label mb-1">This app</div>
        <Row label="Version">v{version || '0.1.0'}</Row>
        <Row label="Author">{AUTHOR}</Row>
        <Row label="Licence">
          MIT ·{' '}
          <button className="text-studio-accent hover:underline" onClick={onLegal}>
            read it under Legal
          </button>
        </Row>
        <Row label="Runtime">{system ? `Electron ${system.electron} · Chromium ${system.chrome}` : inElectron ? 'reading…' : 'browser preview'}</Row>
        <Row label="Rendering" title="The app never competes with a GPU under test">CPU only, GPU acceleration off</Row>
        <Row label="Privacy">No telemetry, no accounts, no cloud</Row>
      </div>
      <div>
        <div className="label mb-1">This PC</div>
        <Row label="Windows">{w ? `${w.name}${w.displayVersion ? ` · ${w.displayVersion}` : ''} · build ${w.build}` : inElectron ? 'reading…' : NOT_IN_APP}</Row>
        <Row label="DirectX">{directXLine(directx)}</Row>
        <Row label="GPU driver">{nvmlDriver ? `${nvmlDriver} (NVIDIA)` : dxDriver ? `${dxDriver} (WDDM)` : inElectron ? 'not read yet' : NOT_IN_APP}</Row>
        <Row label="Collector" title={collector.message}>
          {statusLabel(collector)}
          {h ? ` · ${h.version} · pid ${h.pid} · up ${uptime(h.uptime)}${h.warming ? ' · warming' : ''}` : ''}
        </Row>
        <Row label="PawnIO">
          {h ? (
            h.pawnIo.installed ? (
              `driver open${h.pawnIo.version ? ` · ${h.pawnIo.version}` : ''}`
            ) : (
              // The first laptop had no PawnIO and the row said only that the sensors were off; the fix belongs beside the fact.
              <>
                not installed: CPU and board sensors are off. Get it from{' '}
                <button className="text-studio-accent hover:underline" onClick={() => window.open(PAWNIO_URL, '_blank', 'noopener')} title={PAWNIO_URL}>
                  pawnio.eu
                </button>
                , then restart Strata Tune.
              </>
            )
          ) : inElectron ? (
            'known once the collector answers'
          ) : (
            NOT_IN_APP
          )}
        </Row>
        <Row label="HWiNFO bridge">{system ? `${system.hwinfoRunning ? 'HWiNFO64 is running' : 'HWiNFO64 not running'} · bridge not in this build` : inElectron ? 'reading…' : NOT_IN_APP}</Row>
      </div>
    </div>
  );
};
