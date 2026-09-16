import React from 'react';
import { Placeholder } from './Placeholder';

/** Local AI model advisor (master plan section 10). */
export const Advisor: React.FC = () => (
  <Placeholder title="AI Models" phase="Phase 3">
    Which local AI models this machine can run and how fast, worked out from VRAM, RAM, memory bandwidth and CPU cores
    for each model and quantisation, sorted by the largest that still runs fast, with a context-length slider and the
    download size checked against free space on the model drive.
  </Placeholder>
);
