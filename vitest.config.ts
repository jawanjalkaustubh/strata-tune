import { defineConfig } from 'vitest/config';

// Kept apart from vite.config.ts on purpose: that one loads the Electron
// plugins, which the pure analysis tests never need.
export default defineConfig({
  test: { include: ['tests/**/*.test.{ts,tsx}'] }
});
