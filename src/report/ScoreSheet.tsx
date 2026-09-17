import React from 'react';
import { LOGO_DATA_URL } from '../assets/logo';
import type { ScoreSheet, SheetGpu, SheetRung, SheetStat } from './score-types';
import './report.css';

const thousands = (n: number) => n.toLocaleString('en-US');
const signed = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(Math.round(x))}`;
const pct = (points: number, over: number) => `${points >= over ? '+' : '−'}${(Math.abs((points - over) * 100) / over).toFixed(1)} %`;

const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

const C = { bg: '#0c0e14', panel: '#161b26', border: '#232938', text: '#f1f5f9', muted: '#94a3b8', subtle: '#64748b', ok: '#10b981', idle: '#64748b' };
const SANS = 'ui-sans-serif, system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const MONO = 'ui-monospace, Consolas, "Cascadia Mono", Menlo, monospace';
export const CARD_W = 1200;
export const CARD_H = 630;

const Label: React.FC<{ x: number; y: number; children: string; anchor?: 'start' | 'end'; fill?: string }> = ({ x, y, children, anchor = 'start', fill = C.muted }) => (
  <text x={x} y={y} fontFamily={SANS} fontSize={16} fontWeight={500} letterSpacing="0.08em" fill={fill} textAnchor={anchor}>
    {children.toUpperCase()}
  </text>
);

/**
 * The share card of a scored run (plan §14, §16): 1200×630, the points large, the certified
 * values, the class, the hardware line, the monogram. Inline SVG with system fonts, so the
 * sheet stays one self-contained file and the same markup rasterises on a 2D canvas.
 */
export const HeadroomCard: React.FC<{ sheet: ScoreSheet }> = ({ sheet }) => {
  const s = sheet.score;
  const hardware = `${sheet.hardware.cpu} · ${sheet.hardware.gpu}`;
  const cert = sheet.certified;
  return (
    <svg viewBox={`0 0 ${CARD_W} ${CARD_H}`} role="img" aria-label="Strata Tune headroom score" className="rp-card">
      <rect width={CARD_W} height={CARD_H} fill={C.bg} />
      <rect x={40} y={40} width={CARD_W - 80} height={CARD_H - 80} rx={12} fill={C.panel} stroke={C.border} />
      <rect x={40} y={40} width={6} height={CARD_H - 80} rx={3} fill={s ? C.ok : C.idle} />
      <image href={LOGO_DATA_URL} x={80} y={72} width={48} height={48} />
      <Label x={144} y={92} fill={C.text}>
        Strata Tune
      </Label>
      <Label x={144} y={116}>
        {sheet.run === 'bench' ? 'Built-in bench' : sheet.run === 'as-found' ? 'Headroom score · the card as found' : 'Headroom score'}
      </Label>
      <text x={CARD_W - 80} y={92} fontFamily={MONO} fontSize={16} fill={C.subtle} textAnchor="end">
        {fmtDate(sheet.measuredAt)}
      </text>
      {s ? (
        <>
          <text x={80} y={330} fontFamily={MONO} fontSize={180} fontWeight={500} fill={C.ok}>
            {thousands(s.points)}
          </text>
          <text x={80} y={380} fontFamily={SANS} fontSize={20} fill={C.muted}>
            points · {pct(s.points, sheet.referencePoints)} over a reference RTX 5090 ({thousands(sheet.referencePoints)})
            {sheet.asFoundPoints !== null && sheet.run === 'headroom' ? ` · ${pct(s.points, sheet.asFoundPoints)} over the card as found` : ''}
          </text>
        </>
      ) : (
        <>
          <text x={80} y={300} fontFamily={SANS} fontSize={56} fontWeight={600} fill={C.text}>
            {sheet.run === 'bench' ? 'No points' : 'Not scored'}
          </text>
          <text x={80} y={344} fontFamily={SANS} fontSize={20} fill={C.muted}>
            {sheet.run === 'bench' ? 'the bench measures frame pacing, not throughput' : 'the run ended before its scored measurement'}
          </text>
        </>
      )}
      <line x1={80} x2={CARD_W - 80} y1={450} y2={450} stroke={C.border} />
      <Label x={80} y={486}>
        {cert ? (sheet.sliderTotal ? 'Type into GPU Tweak / Afterburner' : 'Certified on top of the card as found') : sheet.run === 'bench' ? 'Bench' : 'Certified'}
      </Label>
      <text x={80} y={516} fontFamily={MONO} fontSize={24} fill={C.text}>
        {cert
          ? sheet.sliderTotal
            ? `core ${signed(sheet.sliderTotal.coreMhz)} · memory ${signed(sheet.sliderTotal.memMhz)}  (${signed(cert.coreMhz)} / ${signed(cert.memMhz)} NVML MHz on top of the tune)`
            : `core ${signed(cert.coreMhz)} · memory ${signed(cert.memMhz)} MHz${sheet.vendorSlider ? `  (type into GPU Tweak / Afterburner: core ${signed(sheet.vendorSlider.coreMhz)} · memory ${signed(sheet.vendorSlider.memMhz)})` : ''}`
          : sheet.run === 'bench'
            ? sheet.lines[0] ?? ''
            : `nothing above the card as found${sheet.stops?.length ? ` · ${sheet.stops.map((s) => s.ladder).join(' and ')} ladder ended on its limit` : ''}`}
      </text>
      <text x={80} y={572} fontFamily={SANS} fontSize={18} fill={C.muted}>
        {hardware}
        {sheet.deviceClass ? ` · ${sheet.deviceClass}` : ''}
      </text>
    </svg>
  );
};

const Stat: React.FC<{ label: string; stat: SheetStat | null; unit: string; digits?: number; sub?: string }> = ({ label, stat, unit, digits = 0, sub }) =>
  stat ? (
    <tr>
      <td className="label">{label}</td>
      <td>
        {stat.avg.toFixed(digits)} {unit}
        <span className="sub">avg</span>
      </td>
      <td>
        {stat.max.toFixed(digits)} {unit}
        <span className="sub">max</span>
        {sub ? <span className="sub">{sub}</span> : null}
      </td>
    </tr>
  ) : null;

/** The GPU's table: avg and max per row, the cap and the limit-reason shares beneath (plan §16). A figure the card does not report has no row. */
const GpuTable: React.FC<{ g: SheetGpu }> = ({ g }) => {
  const shares = Object.entries(g.limitShare).sort((a, b) => b[1] - a[1]);
  return (
    <section className="rp-panel">
      <div className="label">GPU</div>
      <table className="rp-table rp-stats">
        <tbody>
          <Stat label="Core clock" stat={g.coreMhz} unit="MHz" />
          <Stat label="Memory clock" stat={g.memMhz} unit="MHz" />
          <Stat label="Core temperature" stat={g.coreC} unit="°C" />
          <Stat label="Hotspot" stat={g.hotspotC} unit="°C" />
          <Stat label="Memory junction" stat={g.memoryJunctionC} unit="°C" />
          <Stat label="Board power" stat={g.boardW} unit="W" sub={`cap ${g.powerCapW.toFixed(0)} W`} />
          <Stat label="Fan" stat={g.fanPercent} unit="%" />
        </tbody>
      </table>
      <p className="rp-shares">
        <span className="label">Limit reasons</span>{' '}
        {shares.length ? shares.map(([k, v]) => `${k} ${Math.round(v * 100)} %`).join(' · ') : 'none on any sample'}
      </p>
    </section>
  );
};

const CpuTable: React.FC<{ sheet: ScoreSheet }> = ({ sheet }) => {
  const c = sheet.telemetry?.cpu;
  return (
    <section className="rp-panel">
      <div className="label">CPU</div>
      {c && (c.effectiveMhz || c.packageW || c.tctlC) ? (
        <table className="rp-table rp-stats">
          <tbody>
            <Stat label="Effective clock" stat={c.effectiveMhz} unit="MHz" />
            <Stat label="Package power" stat={c.packageW} unit="W" />
            <Stat label="Tctl" stat={c.tctlC} unit="°C" />
          </tbody>
        </table>
      ) : (
        <p className="rp-note">{sheet.run === 'bench' ? 'The bench records the GPU only.' : 'No CPU telemetry: the library did not read the CPU on this machine (no PawnIO, or an ARM64 build).'}</p>
      )}
      <div className="label rp-sub-label">RAM</div>
      {sheet.ram ? (
        <p className="rp-note">
          <span className="figure">{sheet.ram.totalGiB} GB</span> in {sheet.ram.modules} module{sheet.ram.modules === 1 ? '' : 's'}
          {sheet.ram.configuredMts ? (
            <>
              {' '}
              at <span className="figure">{sheet.ram.configuredMts} MT/s</span>
            </>
          ) : (
            ', speed not reported'
          )}
          {sheet.ram.dimmVoltage !== null ? (
            <>
              {' '}
              · DIMM <span className="figure">{sheet.ram.dimmVoltage.toFixed(3)} V</span>
            </>
          ) : (
            ' · DIMM voltage not read by this board'
          )}
        </p>
      ) : (
        <p className="rp-note">No snapshot: the memory configuration was not read.</p>
      )}
    </section>
  );
};

const verdictClass = (r: SheetRung) => (r.verdict === 'stable' ? 'ok' : r.verdict === 'invalid' ? 'warn' : 'bad');

/** Every rung as tested, the ladder as a score climb in table form, each ladder's rungs ending with the collector's own sentence for why it stopped. */
const Rungs: React.FC<{ rungs: SheetRung[]; asFound: number | null; stops: NonNullable<ScoreSheet['stops']> }> = ({ rungs, asFound, stops }) => {
  const ladders = (['memory', 'core'] as const).filter((l) => rungs.some((r) => r.ladder === l) || stops.some((s) => s.ladder === l));
  return (
    <section className="rp-panel">
      <div className="label">Rungs — the score climb</div>
      <table className="rp-table rp-rungs">
        <thead>
          <tr>
            <th className="label">Ladder</th>
            <th className="label">Offset</th>
            <th className="label">Held</th>
            <th className="label">Result</th>
            <th className="label">Points</th>
          </tr>
        </thead>
        <tbody>
          {asFound !== null && (
            <tr>
              <td>as found</td>
              <td className="figure">+0 / +0</td>
              <td />
              <td className="ok">scored, nothing written</td>
              <td className="figure">{thousands(asFound)}</td>
            </tr>
          )}
          {ladders.map((ladder) => (
            <React.Fragment key={ladder}>
              {rungs
                .filter((r) => r.ladder === ladder)
                .map((r, i) => (
                  <tr key={i}>
                    <td>{r.ladder}</td>
                    <td className="figure">{signed(r.offsetMhz)} MHz</td>
                    <td className="figure">{r.held ? `${r.held.smMhz} / ${r.held.memMhz}` : ''}</td>
                    <td className={verdictClass(r)}>
                      {r.verdict}
                      {r.stage ? ` (stage ${r.stage})` : ''}
                      {r.note ? ` — ${r.note}` : ''}
                    </td>
                    <td className="figure">{r.points !== null ? thousands(r.points) : ''}</td>
                  </tr>
                ))}
              {stops
                .filter((s) => s.ladder === ladder)
                .map((s, i) => (
                  <tr key={`stop-${i}`} className="stop">
                    <td>{ladder}</td>
                    <td className="figure">stopped</td>
                    <td colSpan={3}>{s.text}</td>
                  </tr>
                ))}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </section>
  );
};

/**
 * The score layout (plan §16 'Save as .html', §19), in the order people compare two sheets:
 * the score and the certified values first, the rungs, then one table per component from
 * the run's own telemetry, the hardware line, the PSU as set and the validity block, and the
 * share card last with the export text; date and app version in the footer. Renders the
 * same in the app and in the saved file.
 */
export const ScoreSheetView: React.FC<{ sheet: ScoreSheet; brand?: boolean }> = ({ sheet, brand = true }) => {
  const s = sheet.score;
  const g = sheet.telemetry?.gpu ?? null;
  const held = sheet.held;
  const stops = sheet.stops ?? [];
  return (
    <div className="rp">
      <div className="rp-page">
        <header className="rp-head">
          <div className="rp-brand">
            {brand && <img src={LOGO_DATA_URL} alt="" />}
            <div>
              {brand && <div className="label">Strata Tune</div>}
              <div className="label rp-kind">Comparison sheet</div>
            </div>
          </div>
          <div className="rp-meta">
            <div>
              <span className="figure">{sheet.title}</span> · {fmtDate(sheet.measuredAt)}
            </div>
            <div>
              {sheet.hardware.cpu} · {sheet.hardware.gpu}
              {sheet.deviceClass ? ` · ${sheet.deviceClass}` : ''}
            </div>
          </div>
        </header>

        <section className={`rp-panel rp-verdict ${s ? 'ok' : 'idle'}`}>
          <div className="label">{sheet.run === 'bench' ? 'Bench' : 'Score'}</div>
          {s ? (
            <>
              <h1>
                {thousands(s.points)} points{sheet.run === 'as-found' ? ' as found' : sheet.certified ? ` at ${signed(sheet.certified.coreMhz)} / ${signed(sheet.certified.memMhz)}` : ''}
              </h1>
              <p>
                {sheet.asFoundPoints !== null && sheet.run === 'headroom' ? `${pct(s.points, sheet.asFoundPoints)} over the card as found (${thousands(sheet.asFoundPoints)}), ` : ''}
                {pct(s.points, sheet.referencePoints)} over a reference RTX 5090 ({thousands(sheet.referencePoints)}); {thousands(s.computePoints)} compute at {s.throughputGsps.toFixed(0)} Gsteps/s + {thousands(s.bandwidthPoints)} bandwidth at {s.bandwidthGBs.toFixed(0)} GB/s.
                {sheet.run === 'as-found' && sheet.certified ? ` The certified pair (${signed(sheet.certified.coreMhz)} / ${signed(sheet.certified.memMhz)}) was not scored: the run ended before its official run.` : ''}
              </p>
            </>
          ) : (
            <>
              <h1>{sheet.run === 'bench' ? 'No points' : 'Not scored'}</h1>
              <p>{sheet.lines[sheet.run === 'bench' ? 1 : 0]}</p>
            </>
          )}
          <div className="rp-figures">
            {sheet.sliderTotal ? (
              <div>
                <div className="figure ok">
                  {signed(sheet.sliderTotal.coreMhz)} / {signed(sheet.sliderTotal.memMhz)}
                </div>
                <div className="label">type into GPU Tweak / Afterburner</div>
              </div>
            ) : (
              sheet.vendorSlider && (
                <div>
                  <div className="figure ok">
                    {signed(sheet.vendorSlider.coreMhz)} / {signed(sheet.vendorSlider.memMhz)}
                  </div>
                  <div className="label">type into GPU Tweak / Afterburner</div>
                </div>
              )
            )}
            {sheet.sliderTotal && sheet.vendorSlider && (
              <div>
                <div className="figure">
                  {signed(sheet.vendorSlider.coreMhz)} / {signed(sheet.vendorSlider.memMhz)}
                </div>
                <div className="label">on top of your tune, slider units</div>
              </div>
            )}
            {sheet.certified && (
              <div>
                <div className="figure">
                  {signed(sheet.certified.coreMhz)} / {signed(sheet.certified.memMhz)}
                </div>
                <div className="label">certified on top, NVML MHz</div>
              </div>
            )}
            {held.asFound && (
              <div>
                <div className="figure">
                  {held.asFound.smMhz} / {held.asFound.memMhz}
                </div>
                <div className="label">as found, MHz</div>
              </div>
            )}
            {held.certified && sheet.certified && (
              <div>
                <div className="figure">
                  {held.certified.smMhz} / {held.certified.memMhz}
                </div>
                <div className="label">at the certified pair</div>
              </div>
            )}
            {sheet.confidence && (
              <div>
                <div className="figure">{sheet.confidence}</div>
                <div className="label">confidence</div>
                {sheet.confidenceWhy && <div className="rp-why">{sheet.confidenceWhy}</div>}
              </div>
            )}
          </div>
        </section>

        {(sheet.rungs.length > 0 || stops.length > 0) && <Rungs rungs={sheet.rungs} asFound={sheet.asFoundPoints} stops={stops} />}

        <div className="rp-grid">
          {g ? (
            <GpuTable g={g} />
          ) : (
            <section className="rp-panel">
              <div className="label">GPU</div>
              <p className="rp-note">No GPU telemetry was recorded for this run.</p>
            </section>
          )}
          <CpuTable sheet={sheet} />
        </div>

        <div className="rp-grid">
          <section className="rp-panel">
            <div className="label">Hardware</div>
            <table className="rp-table rp-hardware">
              <tbody>
                <tr>
                  <td className="label">CPU</td>
                  <td>{sheet.hardware.cpu}</td>
                </tr>
                <tr>
                  <td className="label">GPU</td>
                  <td>{sheet.hardware.gpu}</td>
                </tr>
                <tr>
                  <td className="label">Board</td>
                  <td>{sheet.hardware.board}</td>
                </tr>
                <tr>
                  <td className="label">BIOS</td>
                  <td>{sheet.hardware.bios}</td>
                </tr>
                <tr>
                  <td className="label">GPU driver</td>
                  <td>{sheet.hardware.driver}</td>
                </tr>
                <tr>
                  <td className="label">Windows</td>
                  <td>{sheet.hardware.windows}</td>
                </tr>
                <tr>
                  <td className="label">Power supply</td>
                  <td>{sheet.psu.watts ? `${sheet.psu.watts} W${sheet.psu.rating ? ` ${sheet.psu.rating}` : ''} (as set by the user)` : 'not set'}</td>
                </tr>
                {sheet.telemetry && (
                  <tr>
                    <td className="label">Samples</td>
                    <td>
                      {sheet.telemetry.samples} over {Math.round(sheet.telemetry.seconds)} s
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>
          <section className="rp-panel">
            <div className="label">Validity</div>
            <table className="rp-table rp-validity">
              <tbody>
                {sheet.validity.map((v) => (
                  <tr key={v.label}>
                    <td className="label">{v.label}</td>
                    <td>
                      <span className={`figure ${v.ok === null ? 'idle' : v.ok ? 'ok' : 'warn'}`}>{v.ok === null ? '—' : v.ok ? '✓' : '✗'}</span> {v.text}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>

        <section className="rp-panel rp-card-panel">
          <HeadroomCard sheet={sheet} />
        </section>

        {sheet.lines.length > 0 && (
          <section className="rp-panel">
            <div className="label">{sheet.run === 'bench' ? 'Verdict' : 'Values and what the card holds'}</div>
            {sheet.lines.map((line, i) => (
              <p key={i} className="rp-line">
                {line}
              </p>
            ))}
          </section>
        )}

        <footer className="rp-foot">
          <span>{sheet.footer} Serial numbers, host names and user names are not in this sheet.</span>
          <span>Strata Tune{sheet.appVersion ? ` ${sheet.appVersion}` : ''}</span>
        </footer>
      </div>
    </div>
  );
};
