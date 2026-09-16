import React from 'react';
import { Timer, RotateCcw } from 'lucide-react';
import type { OllamaBench, OllamaInstalled } from '../../api';
import { Card } from './Card';
import { Pill } from '../monitor/Pill';
import { MtpTag, Tag } from './Tag';
import { gib, tokS } from './format';
import { FACTOR_BAND, estimateFor, inFactor, type ViewRow } from './rows';

interface Props {
  installed: OllamaInstalled[] | null;
  loaded: string[];
  /** Ollama reachable through the app; the plain browser has no bridge to it. */
  available: boolean;
  /** Nothing answers on :11434: the plan's one quiet line, not an error. */
  ollamaAbsent: boolean;
  listError: string;
  /** The advisor row for each installed pull tag, when models.json knows it. */
  estimates: Record<string, ViewRow | undefined>;
  measurements: Record<string, OllamaBench>;
  calibrating: string | null;
  calibrateError: string;
  factor: number;
  defaultFactor: number;
  factorIsSet: boolean;
  derived: number | null;
  onCalibrate: (model: string) => void;
  onSetFactor: () => void;
  onResetFactor: () => void;
}

const HEAD = 'label text-studio-subtle font-normal text-left';

/** Plan section 10: a timed 256-token generation per installed model beside the estimate; the median ratio becomes the factor. */
export const Calibration: React.FC<Props> = (p) => {
  const busy = p.calibrating !== null;
  const outOfBand = p.derived !== null && (p.derived < FACTOR_BAND[0] || p.derived > FACTOR_BAND[1]);
  return (
    <Card
      title="Tokens/s calibration"
      aside={
        <span className="flex items-center gap-1.5 text-mini">
          <span className="label">factor</span>
          <span className="figure text-studio-text">{p.factor.toFixed(2)}</span>
          <Tag kind={p.factorIsSet ? 'measured' : 'default'} title={p.factorIsSet ? 'Set from measurements on this box' : `Analysis default ${p.defaultFactor}`} />
        </span>
      }
    >
      {!p.available ? (
        <p className="text-mini text-studio-muted">Calibration needs the app: the plain browser cannot reach Ollama.</p>
      ) : p.ollamaAbsent ? (
        <p className="text-mini text-studio-muted" title={p.listError}>
          Install Ollama to measure real tokens/s on your models.
        </p>
      ) : p.listError ? (
        <p className="text-mini text-studio-muted">{p.listError}</p>
      ) : !p.installed ? (
        <p className="text-mini text-studio-muted">Asking Ollama for its models…</p>
      ) : p.installed.length === 0 ? (
        <p className="text-mini text-studio-muted">Ollama is running but has no models; pull one to calibrate.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-mini border-separate border-spacing-0">
            <thead>
              <tr>
                <th className={HEAD}>Model</th>
                <th className={`${HEAD} text-right`}>Size</th>
                <th className={`${HEAD} text-right`}>Estimate</th>
                <th className={`${HEAD} text-right`}>Measured</th>
                <th className={`${HEAD} text-right`}>Ratio</th>
                <th className={HEAD} />
              </tr>
            </thead>
            <tbody>
              {p.installed.map((m) => {
                const est = p.estimates[m.name];
                const meas = p.measurements[m.name];
                const expected = est ? estimateFor(est) : null;
                const perModel = meas && expected ? meas.tokPerSec / (expected / p.factor) : null;
                const counted = inFactor(est);
                return (
                  <tr key={m.name} className="border-t border-studio-border">
                    <td className="py-1.5 pr-3 border-t border-studio-border">
                      <span className="text-studio-text">{m.name}</span>
                      {p.loaded.includes(m.name) && (
                        <span className="ml-2">
                          <Pill tone="ok">loaded</Pill>
                        </span>
                      )}
                      {!est && <span className="ml-2 text-[10px] text-studio-subtle">not in models.json</span>}
                    </td>
                    <td className="py-1.5 pr-3 text-right figure text-studio-muted border-t border-studio-border">{gib(m.sizeBytes)}</td>
                    <td className="py-1.5 pr-3 text-right border-t border-studio-border whitespace-nowrap">
                      {est && expected ? (
                        <>
                          <span className="figure text-studio-text">{tokS(expected)}</span> <Tag kind="estimated" />
                          {est.bucket === 'slow' && <span className="text-[10px] text-studio-subtle"> offloaded</span>}
                          {est.mtpAcceptedTokens !== null && (
                            <>
                              {' '}
                              <MtpTag accepted={est.mtpAcceptedTokens} />
                            </>
                          )}
                        </>
                      ) : (
                        <span className="text-studio-subtle">—</span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3 text-right border-t border-studio-border whitespace-nowrap">
                      {meas ? (
                        <span title={`prompt ${tokS(meas.promptTokPerSec)} tok/s · load ${(meas.loadMs / 1000).toFixed(1)} s · total ${(meas.totalMs / 1000).toFixed(1)} s`}>
                          <span className="figure text-emerald-400">{tokS(meas.tokPerSec)}</span> <Tag kind="measured" />
                        </span>
                      ) : (
                        <span className="text-studio-subtle">—</span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3 text-right figure text-studio-muted border-t border-studio-border whitespace-nowrap">
                      {perModel === null ? (
                        '—'
                      ) : counted ? (
                        perModel.toFixed(2)
                      ) : (
                        <span className="text-studio-subtle" title="Left out of the factor: the measured rate includes accepted draft tokens, which vary with the text">
                          {perModel.toFixed(2)} <span className="text-[10px]">not in factor</span>
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 text-right border-t border-studio-border">
                      <button className="btn h-6" disabled={busy} onClick={() => p.onCalibrate(m.name)} title="Times a fixed 256-token generation; a model that is not loaded takes longer the first time">
                        <Timer size={12} /> {p.calibrating === m.name ? 'Timing…' : 'Calibrate'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {p.calibrateError && <p className="text-mini text-rose-300">{p.calibrateError}</p>}
      {p.available && p.installed && p.installed.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap pt-1">
          <button className="btn" disabled={p.derived === null || busy} onClick={p.onSetFactor} title="Median of measured ÷ estimated over the calibrated models">
            Set factor from measurements{p.derived !== null && <span className="figure text-studio-text">→ {p.derived.toFixed(2)}</span>}
          </button>
          {p.factorIsSet && (
            <button className="btn" onClick={p.onResetFactor}>
              <RotateCcw size={12} /> Reset to {p.defaultFactor}
            </button>
          )}
          {outOfBand && (
            <span className="text-[10px] text-amber-400">
              Outside the {FACTOR_BAND[0]}–{FACTOR_BAND[1]} a clean decode lands in: was the card busy (a game, the worker, another Strata app) or the model partly in RAM?
            </span>
          )}
          <span className="text-[10px] text-studio-subtle">
            Ratio is measured ÷ estimate at factor 1; the factor scales every estimate on this page. A model with MTP is shown but left out of the median, not divided by its
            multiplier: its accepted draft length moves with the text.
          </span>
        </div>
      )}
    </Card>
  );
};
