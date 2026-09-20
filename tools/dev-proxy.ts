import { Agent } from 'node:https';
import type { ProxyOptions } from 'vite';

// Local development only; production publishes the static app in dist/.
export const developmentProxy = {
  // Narrow FAA-only fallback for PDF.js: FAA's PDF host does not allow CORS.
  '^/faa-procedures/\\d{4}/[-\\w]+\\.[pP][dD][fF](?:\\?.*)?$': {
    target: 'https://aeronav.faa.gov',
    changeOrigin: true,
    proxyTimeout: 120_000,
    rewrite: path => path.replace(/^\/faa-procedures/, '/d-tpp'),
  },
  '/chart-data': {
    target: 'https://charts.tedyin.com',
    changeOrigin: true,
    rewrite: path => path.replace(/^\/chart-data/, '/charts'),
  },
  '/weather/metars.geojson': {
    target: 'https://aviationweather.gov',
    agent: new Agent({
      keepAlive: true,
      maxSockets: 2,
      autoSelectFamilyAttemptTimeout: 2_000,
    }),
    proxyTimeout: 15_000,
    changeOrigin: true,
    headers: { 'User-Agent': 'zlayer-development/0.1' },
    rewrite: path => path.replace(/^\/weather\/metars\.geojson/, '/api/data/metar'),
  },
  '/weather/tafs.json': {
    target: 'https://aviationweather.gov',
    changeOrigin: true,
    proxyTimeout: 25_000,
    headers: { 'User-Agent': 'zlayer-development/0.1' },
    rewrite: path => path.replace(/^\/weather\/tafs\.json/, '/api/data/taf'),
  },
} satisfies Record<string, ProxyOptions>;
