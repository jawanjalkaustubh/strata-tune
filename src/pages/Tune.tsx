import React, { useEffect, useRef } from 'react';
import { AuditPanel } from './Audit';
import { Headroom } from '../components/tune/Headroom';
import { takeIntent } from '../components/navigate';
import { api } from '../api';

/**
 * Tune, the home page (plan section 17, user 2026-09-16: "what's the point of Audit as a
 * separate window? it should be in the Tune section"): the audit on top — score, ranked
 * findings, what to change in BIOS or Windows — and beneath it, behind the settings switch
 * and the warning, the Headroom hunt that hands over OC values for the vendor tool. The
 * app never changes a setting or leaves a clock on the card; everything here is "here is
 * what we found, here is what to type where". An 'audit' intent lands on the top half.
 */
export const Tune: React.FC = () => {
  const audit = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (takeIntent() === 'audit') audit.current?.scrollIntoView({ block: 'start' });
  }, []);
  return (
    <div className="p-4 max-w-5xl w-full mx-auto space-y-6 min-w-0">
      <div id="audit" ref={audit}>
        <AuditPanel />
      </div>
      {/* The hunt drives NVIDIA clock offsets; on a Mac there is nothing to hunt, so the section is not there at all (docs/MACOS.md). */}
      {api?.platform !== 'darwin' && <Headroom />}
    </div>
  );
};
