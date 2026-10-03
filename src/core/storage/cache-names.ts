// Keep existing namespaces: releases must not invalidate downloaded files.
export const CHART_CACHE = 'zlayers-chart-archives-v3';
export const DATA_CACHE = 'zlayers-data-v6';
export const PDF_CACHE = 'zlayers-procedures-v1';
export const BASEMAP_CACHE = 'zlayers-basemap-v1';
export const BASEMAP_METADATA_CACHE = `${BASEMAP_CACHE}:metadata`;
// Older open pages must never mistake an OPFS receipt for a whole-file body.
// Keep their complete entries readable and put new receipts in separate caches.
export const fileReceiptCacheName = (name: string) => `zlayers-file-receipts-v1:${name}`;
export const VERIFIED_SHA256_HEADER = 'x-zlayers-verified-sha256';
