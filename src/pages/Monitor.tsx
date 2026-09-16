import React from 'react';
import { Placeholder } from './Placeholder';

/** Live view (master plan sections 9, 13, 16). */
export const Monitor: React.FC = () => (
  <Placeholder title="Monitor" phase="Phase 2">
    The 2 Hz live view of clocks, power (every number tagged measured or estimated), temperatures, fans, VRAM and the
    GPU's own perf-limit reasons as a label, plain DOM with no animation, which is also the view shown during a Tune test
    with its validity indicator.
  </Placeholder>
);
