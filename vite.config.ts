import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

import { developmentProxy } from './tools/dev-proxy.ts';
import { offlineShell } from './tools/offline-shell.ts';
import { terrainSamplerPrecision } from './tools/terrain-sampler-precision.ts';

export default defineConfig(({ command }) => ({
  plugins: [react(), offlineShell(), terrainSamplerPrecision()],
  optimizeDeps: {
    // Resolve the pinned SQLite worker wrapper when the dev server starts.
    include: ['comlink'],
    // Keep the terrain sampler fix active in development as well as builds.
    exclude: ['maplibre-gl'],
  },
  ...(command === 'build'
    ? {
        build: {
          chunkSizeWarningLimit: 1_300,
          rolldownOptions: {
            input: {
              app: resolve(import.meta.dirname, 'index.html'),
              sw: resolve(import.meta.dirname, 'src/service-worker.ts'),
            },
            output: {
              // Cache the large, stable ownership masks independently of app changes.
              codeSplitting: {
                groups: [{ name: 'region-boundaries', test: /\/offline\/region-boundaries\.json$/ }],
              },
              entryFileNames: (chunk) =>
                chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js',
            },
          },
        },
      }
    : {}),
  server: {
    port: 4173,
    strictPort: true,
    headers: { 'Service-Worker-Allowed': '/' },
    proxy: developmentProxy,
  },
}));
