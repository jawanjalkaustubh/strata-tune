import React from 'react';
import { Placeholder } from './Placeholder';

/** Sessions and reports (master plan sections 11, 12, 13, 15, 19). */
export const Capture: React.FC = () => (
  <Placeholder title="Capture" phase="Phases 4 to 7">
    Frame-time captures of a running game through PresentMon, listed as sessions; opening one shows the report (same
    renderer as the exported HTML): headline verdict, every stutter classified by cause with a fix or the sentence
    "no setting on your end changes this", CPU-bound versus GPU-bound, whole-system power and the before/after delta.
  </Placeholder>
);
