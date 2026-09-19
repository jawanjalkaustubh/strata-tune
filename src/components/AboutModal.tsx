import React, { useEffect, useState } from 'react';
import { ArrowLeft, Bug, Check, ClipboardList, Copy, Cpu, ExternalLink, FileText, FolderOpen, Heart, Share2, Timer, X } from 'lucide-react';
import { api, ipcErrorMessage } from '../api';
import { SupportLinks, openExternal } from '../support';
import { Monogram } from './Monogram';
import { useCollectorStatus } from './useCollectorStatus';
import { useAboutInfo } from './about/useAboutInfo';
import { Facts } from './about/Facts';
import { Legal } from './about/Legal';
import { ClocksTool } from './about/ClocksTool';
import { TimersTool } from './about/TimersTool';
import { ValidationTool } from './about/ValidationTool';
import { buildSystemReport, hardwareSummary } from './about/systemReport';
import { cachedSensorMeta, cachedSnapshot } from './monitor/cache';
import type { LegalTab } from './about/legalText';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  version: string;
  support: SupportLinks;
}

type Tool = 'clocks' | 'timers' | 'validation';

const TOOL_TITLE: Record<Tool, string> = { clocks: 'Clocks', timers: 'Timers', validation: 'Validation' };

const ToolButton: React.FC<{ icon: React.ReactNode; label: string; onClick: () => void; title?: string; disabled?: boolean }> = ({ icon, label, onClick, title, disabled }) => (
  <button className="btn justify-start h-8 w-full border border-studio-border bg-studio-panel/60 hover:bg-studio-panel-hi" onClick={onClick} title={title} disabled={disabled}>
    {icon} <span className="whitespace-normal text-left">{label}</span>
  </button>
);

/**
 * About as a utility hub in the CPU-Z tradition (plan 17 'About'): the facts of this app
 * and this install, a Tools block, and the Legal block with the bundled texts (plan 27a).
 * A tool opens inside the same dialog with a way back; Escape and the backdrop close it.
 */
export const AboutModal: React.FC<Props> = ({ isOpen, onClose, version, support }) => {
  const [tool, setTool] = useState<Tool | null>(null);
  const [legalTab, setLegalTab] = useState<LegalTab>('licence');
  const [note, setNote] = useState('');
  const [copied, setCopied] = useState(false);
  const collector = useCollectorStatus();
  const info = useAboutInfo(isOpen);
  const connected = collector.status === 'connected';

  useEffect(() => {
    if (!isOpen) return;
    setTool(null);
    setNote('');
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  /** Snapshot, spec sheet and the current sensors, redacted, as .txt or .html (plan 17). */
  const saveReport = async (kind: 'txt' | 'html') => {
    if (!api) return;
    setNote('');
    try {
      const [snapshot, meta, latest, timers] = connected
        ? await Promise.all([cachedSnapshot(), cachedSensorMeta(), api.collector.sensorsLatest(), api.about.timers().catch(() => null)])
        : [null, [], null, null];
      const report = buildSystemReport({
        version, generatedAt: new Date().toISOString(), snapshot, meta, latest, system: info.system,
        directx: info.directx && info.directx !== 'reading' ? info.directx : null, timers
      });
      const path = await api.about.saveFile({
        title: 'Save system report',
        defaultName: `${report.fileBase}.${kind}`,
        filters: [{ name: kind === 'txt' ? 'Text report' : 'HTML report', extensions: [kind] }],
        text: kind === 'txt' ? report.text : report.html
      });
      setNote(path ? `Saved ${path}${connected ? '' : ' (the collector is not connected: no snapshot or sensors in it)'}` : '');
    } catch (e) {
      setNote(`Could not save the report: ${ipcErrorMessage(e)}`);
    }
  };

  const copySummary = async () => {
    setNote('');
    try {
      const snapshot = api && connected ? await cachedSnapshot() : null;
      const text = hardwareSummary(snapshot, info.system);
      if (!text) {
        setNote('Nothing to copy yet: the collector has not answered the snapshot.');
        return;
      }
      await navigator.clipboard.writeText(text);
      setNote(`Copied: ${text}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      setNote(`Could not copy: ${ipcErrorMessage(e)}`);
    }
  };

  const openLogs = () => {
    setNote('');
    api?.about.openLogs().catch((e) => setNote(`Could not open the logs folder: ${ipcErrorMessage(e)}`));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onMouseDown={(e) => e.target === e.currentTarget && onClose()} role="dialog" aria-modal="true" aria-label="About Strata Tune">
      <div className="w-full max-w-3xl max-h-[92vh] flex flex-col bg-studio-surface border border-studio-border rounded-lg shadow-2xl overflow-hidden">
        <div className="flex items-center gap-3 px-5 h-14 border-b border-studio-border bg-gradient-to-r from-emerald-950/50 via-studio-surface to-studio-surface shrink-0">
          {tool ? (
            <button className="btn -ml-2" onClick={() => setTool(null)}>
              <ArrowLeft size={14} /> About
            </button>
          ) : (
            <Monogram size={28} glow={false} />
          )}
          <div className="min-w-0">
            <h2 className="text-sm font-extrabold tracking-wider text-white leading-4">{tool ? TOOL_TITLE[tool].toUpperCase() : 'STRATA TUNE'}</h2>
            <div className="text-micro text-emerald-300/80 font-mono">{tool ? `Strata Tune v${version || '0.1.0'}` : `v${version || '0.1.0'} · PC tuning and diagnostics · free, no telemetry`}</div>
          </div>
          <span className="flex-1" />
          <button className="btn-icon" onClick={onClose} aria-label="Close">
            <X size={14} />
          </button>
        </div>

        <div className="p-5 space-y-5 overflow-y-auto">
          {tool === 'clocks' && <ClocksTool connected={connected} />}
          {tool === 'timers' && <TimersTool connected={connected} />}
          {tool === 'validation' && <ValidationTool connected={connected} version={version} />}
          {!tool && (
            <>
              <Facts version={version} system={info.system} directx={info.directx} collector={collector} onLegal={() => {
                setLegalTab('licence');
                document.getElementById('about-legal')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }} />
              {info.error && <p className="text-micro text-rose-300">{info.error}</p>}

              <section className="space-y-2" aria-label="Tools">
                <div className="label">Tools</div>
                <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3">
                  <ToolButton icon={<FileText size={14} />} label="Save system report (.txt)" onClick={() => saveReport('txt')} disabled={!api} title="Snapshot, spec sheet and current sensors; serials redacted" />
                  <ToolButton icon={<FileText size={14} />} label="Save system report (.html)" onClick={() => saveReport('html')} disabled={!api} title="The same report as a page" />
                  <ToolButton icon={<Cpu size={14} />} label="Clocks" onClick={() => setTool('clocks')} title="Live per-core and GPU clock table" />
                  <ToolButton icon={<Timer size={14} />} label="Timers" onClick={() => setTool('timers')} title="Timer resolution, QPC frequency and clock source" />
                  <ToolButton icon={<Share2 size={14} />} label="Validation" onClick={() => setTool('validation')} title="The 60 s scored run and the share card" />
                  <ToolButton icon={copied ? <Check size={14} /> : <Copy size={14} />} label="Copy hardware summary" onClick={copySummary} title="One line: CPU, GPU, RAM, board, Windows" />
                  <ToolButton icon={<FolderOpen size={14} />} label="Open logs folder" onClick={openLogs} disabled={!api} title={info.system?.logsFolder ?? '%LOCALAPPDATA%\\Strata Tune\\logs'} />
                  {support.donateUrl && <ToolButton icon={<Heart size={14} className="text-state-danger-400" />} label={support.donateLabel} onClick={() => openExternal(support.donateUrl)} title={support.donateUrl} />}
                  {support.projectUrl && <ToolButton icon={<ExternalLink size={14} />} label="Project page" onClick={() => openExternal(support.projectUrl)} title={support.projectUrl} />}
                  {support.issuesUrl && <ToolButton icon={<Bug size={14} />} label="Report an issue" onClick={() => openExternal(support.issuesUrl)} title={support.issuesUrl} />}
                </div>
                {note && <p className="text-micro text-studio-subtle break-words">{note}</p>}
                {!support.donateUrl && (
                  <p className="text-micro text-studio-subtle">Strata Tune is free. Donations, when a page exists, are voluntary, buy nothing and are not required.</p>
                )}
              </section>

              <Legal texts={info.legal} tab={legalTab} onTab={setLegalTab} />

              <div className="text-micro text-studio-subtle flex items-center gap-1.5">
                <ClipboardList size={12} /> Part of the Strata family with Strata Code, Strata Photo, Strata Video and StrataSnap. Runs entirely on your own hardware.
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
