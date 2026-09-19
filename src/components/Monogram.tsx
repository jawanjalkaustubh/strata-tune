import React from 'react';
import { LOGO_DATA_URL } from '../assets/logo';

/** The St mark, one place for its glow so every bar draws it the same way. */
export const Monogram: React.FC<{ size?: number; glow?: boolean; className?: string }> = ({ size = 20, glow = true, className = '' }) => (
  <img
    src={LOGO_DATA_URL}
    alt="Strata Tune"
    width={size}
    height={size}
    className={`object-contain ${glow ? 'drop-shadow-[0_0_8px_rgba(16,185,129,0.55)]' : ''} ${className}`}
    draggable={false}
  />
);
