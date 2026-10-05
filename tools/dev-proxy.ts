import type { ProxyOptions } from 'vite';

// Preserve the selected backend in dev sessions started before the server rename.
const infoOrigin = process.env.INFO_API_ORIGIN || process.env.WEATHER_API_ORIGIN || 'https://zlayer.tedyin.com';

// Local development only; production publishes the static app in dist/.
export const developmentProxy = {
  // Reuse production's prepared data. Override only when developing the backend.
  '/api/weather/': {
    target: infoOrigin, changeOrigin: true, proxyTimeout: 60_000,
  },
  '/api/notams/': {
    target: infoOrigin, changeOrigin: true, proxyTimeout: 60_000,
  },
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
} satisfies Record<string, ProxyOptions>;
