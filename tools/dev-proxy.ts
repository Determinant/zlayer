import type { ProxyOptions } from 'vite';

// Local development only; production publishes the static app in dist/.
export const developmentProxy = {
  // Reuse production's prepared data. Override only when developing the backend.
  '/api/weather/': {
    target: process.env.WEATHER_API_ORIGIN || 'https://zlayer.tedyin.com', changeOrigin: true, proxyTimeout: 60_000,
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
