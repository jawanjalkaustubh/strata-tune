import React from 'react';
import { Card } from './Card';
import { MoeTag, MtpTag, Tag } from './Tag';
import { tokS } from './format';
import { USE_TAGS, type UseTag, type ViewRow } from './rows';

interface Props {
  picks: Record<UseTag, ViewRow | null>;
  /** Measured tok/s by Ollama pull tag, from the calibration table. */
  measured: Record<string, number>;
  contextTokens: string;
}

/** Plan section 10: the largest model per use that still runs fast at the chosen context. */
export const BestFor: React.FC<Props> = ({ picks, measured, contextTokens }) => (
  <Card title="Best model for" aside={<span className="label">at {contextTokens} context</span>}>
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {USE_TAGS.map((tag) => {
        const r = picks[tag];
        const m = r ? measured[r.pullTag] : undefined;
        return (
          <div key={tag} className="rounded-md border border-studio-border bg-studio-surface px-3 py-2 min-w-0">
            <div className="label mb-1">{tag}</div>
            {r ? (
              <>
                <div className="text-sm font-semibold text-studio-text truncate" title={r.pullTag}>
                  {r.name}
                </div>
                <div className="text-[10px] text-studio-subtle figure truncate">{r.pullTag}</div>
                <div className="mt-1 flex items-baseline gap-1.5 flex-wrap">
                  {r.tokPerSec !== null ? (
                    <>
                      <span className={`figure text-[13px] ${r.cpuOnly ? 'text-studio-text' : 'text-emerald-400'}`}>{tokS(r.cpuOnly && r.tokPerSecOffloaded !== null ? r.tokPerSecOffloaded : r.tokPerSec)}</span>
                      <span className="text-[10px] text-studio-subtle">{r.cpuOnly ? 'tok/s on the CPU' : 'tok/s'}</span>
                      <Tag kind="estimated" />
                      {r.mtpAcceptedTokens !== null && <MtpTag accepted={r.mtpAcceptedTokens} />}
                      {r.moe && <MoeTag />}
                    </>
                  ) : (
                    <span className="text-[10px] text-studio-subtle">tok/s needs a bandwidth figure</span>
                  )}
                  {m !== undefined && (
                    <>
                      <span className="figure text-studio-text text-[13px] ml-1">{tokS(m)}</span>
                      <Tag kind="measured" />
                    </>
                  )}
                </div>
              </>
            ) : (
              <div className="text-mini text-studio-muted">Nothing tagged {tag} runs fast at this context.</div>
            )}
            {r?.cpuOnly && <div className="text-[10px] text-studio-subtle mt-1">from RAM; a discrete GPU is what changes this</div>}
          </div>
        );
      })}
    </div>
  </Card>
);
