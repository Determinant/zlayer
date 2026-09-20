const PUBLIC_CHART_ROOT = 'https://charts.tedyin.com/charts';

// Shared by the page and service worker: a configured feed must not bypass the
// whole-file cache just because its host or path differs from the default.
export function chartRoot(): string {
  return (import.meta.env?.VITE_ZLAYERS_CHART_ROOT?.trim() ||
    (import.meta.env?.DEV ? '/chart-data' : PUBLIC_CHART_ROOT)).replace(/\/+$/, '');
}

export function isOnChartFeed(url: URL, baseUrl: string, root = chartRoot()): boolean {
  const feed = new URL(root, baseUrl);
  return url.origin === feed.origin && url.pathname.startsWith(`${feed.pathname.replace(/\/+$/, '')}/`);
}
