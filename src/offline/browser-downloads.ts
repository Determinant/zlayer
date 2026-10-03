import { prepareRouteHistory } from '../layers/routes/history/client';
import { preparePwa } from '../pwa';
import { captureReference } from '../core/data/reference-snapshot';
import type { ReferenceResource } from '../core/data/references';
import { withReferenceSnapshot } from './reference-snapshot';
import { regionReferencesReady } from './reference-readiness';
import { savedPlans } from './saved-plans';
import { snapshotFilesIncluded } from './plan-records';
import { RegionDownloads, retainedFiles, type OfflineFile } from './downloads';
import { stageRegion, activateRegion, forgetRegion } from './region-repository';
import { CHART_CACHE, DATA_CACHE, PDF_CACHE } from '../core/storage/cache-names';
import { cachedFileBytes, fileCache, storageStatus, formatBytes } from './storage';
import { httpResourceError, isResourceErrorCode, ResourceError } from '../core/data/errors';
import { discardResponseBody } from '../core/storage/response';
import { prepareRegionTerrain } from './terrain';
import { openFileCache } from '../core/storage/download-file';
import { activeFileUrls } from './active-catalogs';
import { pruneBundleSnapshots } from './bundle-snapshots';
import { removeTemporaryBasemapFiles } from '../core/storage/basemap-cache';

async function exclusive(work: () => Promise<void>): Promise<void> {
  if (!navigator.locks) throw new Error('This browser lacks safe multi-window download coordination; update your browser');
  await navigator.locks.request('zlayer-region-downloads', { ifAvailable: true }, async lock => {
    if (!lock) throw new Error('Another ZLayer window is managing downloads. Retry when it finishes.');
    await work();
  });
}

/** Remove temporary charts, PDFs and basemap tiles, preserving every saved region. */
export async function removeUnsavedFiles(): Promise<void> {
  await exclusive(async () => {
    const plans = await savedPlans(true);
    const keep = new Set([...plans.flatMap(plan => retainedFiles(plan).map(file => file.url)),
      ...await activeFileUrls()]);
    for (const name of [CHART_CACHE, PDF_CACHE]) {
      const cache = await openFileCache(name);
      for (const request of await cache.keys()) if (!keep.has(request.url)) {
        await cache.delete(request);
        if (name === CHART_CACHE) navigator.serviceWorker.controller?.postMessage({ type: 'forget-chart-memory', url: request.url });
      }
    }
    await pruneBundleSnapshots(plans);
    await removeTemporaryBasemapFiles();
  });
}

export function createBrowserDownloads(downloadPdf: (file: OfflineFile) => Promise<void>): RegionDownloads {
  return new RegionDownloads({
    list: savedPlans,
    save: stageRegion,
    complete: activateRegion,
    forget: forgetRegion,
    cachedBytes: cachedFileBytes,
    referencesReady: regionReferencesReady,
    prepare: async (plan, signal, readCached = cachedFileBytes) => {
      signal.throwIfAborted();
      if (!snapshotFilesIncluded(plan)) throw new Error('Saved book metadata does not match its files. Use Update to latest for this region.');
      if (plan.references.some(resource => resource.id === 'unverified')) throw new Error(
        'This older selection needs updated reference metadata. Reload feeds and use Update to latest; saved files are kept.',
      );
      if (!await preparePwa()) throw new Error('Offline service worker unavailable. Reload online and retry.');
      signal.throwIfAborted();
      plan = await prepareRegionTerrain(plan, signal);
      const storage = await storageStatus();
      signal.throwIfAborted();
      if (storage.quota !== undefined && storage.usage !== undefined) {
        let required = 0;
        for (const file of plan.files) {
          signal.throwIfAborted();
          if (await readCached(file) === undefined) required += file.byteLength ?? 0;
        }
        const cache = await caches.open(DATA_CACHE);
        for (const resource of plan.references) if (resource.id === 'route-history') {
          const stored = await cache.match(resource.url);
          if (!stored) required += resource.bytes;
          discardResponseBody(stored);
        }
        if (required > storage.quota - storage.usage) throw new Error(
          `This download needs ${formatBytes(required)} more space. Remove saved regions or free device storage, then retry.`,
        );
      }
      const references: ReferenceResource[] = [];
      for (const resource of plan.references) {
        signal.throwIfAborted();
        if (resource.id === 'chart-supplements' && resource.snapshot) { references.push(resource); continue; }
        if (resource.id === 'chart-supplements' || resource.id === 'unverified') {
          throw new Error('Saved reference metadata is incomplete. Use Update to latest for this region.');
        }
        if (resource.id === 'route-history') {
          references.push(await prepareRouteHistory(resource, plan.revision, signal));
          continue;
        }
        references.push(await captureReference(resource, plan.revision, signal));
      }
      signal.throwIfAborted();
      return withReferenceSnapshot(plan, references);
    },
    download: async file => {
      if (file.kind !== 'chart' && file.kind !== 'terrain') {
        await downloadPdf(file);
        return;
      }
      // HEAD still causes exactly one verified whole-file GET in the service worker.
      // No tile prefetching and no duplicate PDF/MBTiles storage for offline regions.
      const response = await fetch(file.url, { method: 'HEAD', signal: AbortSignal.timeout(180_000) });
      if (!response.ok) {
        const message = response.headers.get('x-zlayer-error') ??
          `Download failed (${response.status}); retry when online with free storage`;
        const code = response.headers.get('x-zlayer-error-code');
        throw isResourceErrorCode(code) ? new ResourceError(code, message) : httpResourceError(response.status, message);
      }
    },
    remove: async file => {
      await (await openFileCache(fileCache(file))).delete(file.url);
      navigator.serviceWorker.controller?.postMessage({ type: 'forget-chart-memory', url: file.url });
    },
    exclusive,
  });
}
