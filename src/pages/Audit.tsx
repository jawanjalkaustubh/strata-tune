import React from 'react';
import { Placeholder } from './Placeholder';

/** Home page (master plan sections 8, 14, 17). */
export const Audit: React.FC = () => (
  <Placeholder title="Audit" phase="Phase 1">
    The five things that cost this PC the most performance, ranked by severity times estimated cost with a fix for each
    (EXPO/XMP, RAM channels, PCIe link, Resizable BAR, power plan, drive space, thermal headroom, driver age, background
    hogs), with the system score at the top once it exists, an All sensors button and the pinned-sensor strip.
  </Placeholder>
);
