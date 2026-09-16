import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

/**
 * The standalone report (master plan §19): src/report/report-template.html with
 * its script and stylesheet inlined, written to dist-report/report-template.html.
 * Kept apart from vite.config.ts, which builds the Electron shell. The empty
 * postcss config keeps the app's Tailwind pipeline out of a page that must not
 * depend on it.
 */
const template = fileURLToPath(new URL('./src/report/report-template.html', import.meta.url));

export default defineConfig({
  root: 'src/report',
  base: './',
  plugins: [react(), viteSingleFile()],
  css: { postcss: {} },
  build: {
    outDir: '../../dist-report',
    emptyOutDir: true,
    rollupOptions: { input: template }
  }
});
