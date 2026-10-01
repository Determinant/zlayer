import type { DownloadPlan } from './downloads';
import { readBundleSnapshot } from './bundle-snapshots';
import { regionTerrainFiles } from '../layers/terrain/offline';

export async function prepareRegionTerrain(plan: DownloadPlan, signal: AbortSignal): Promise<DownloadPlan> {
  if (!plan.terrain) return plan; // Older selections keep their original, explicitly limited scope.
  const source = (plan.catalog ?? await readBundleSnapshot(plan))?.terrain;
  if (!source || !plan.bounds?.length) throw new Error('Terrain metadata is missing. Reload feeds and use Update to latest for this region.');
  const files = await regionTerrainFiles(plan.bounds, source, location.href, signal);
  return { ...plan, files: [...plan.files.filter(file => file.kind !== 'terrain'), ...files] };
}

export async function terrainFilesIncluded(plan: DownloadPlan, signal = new AbortController().signal): Promise<boolean> {
  signal.throwIfAborted();
  if (!plan.terrain) return true;
  const source = (plan.catalog ?? await readBundleSnapshot(plan))?.terrain;
  if (!source || !plan.bounds?.length) return false;
  try {
    const expected = await regionTerrainFiles(plan.bounds, source, location.href, signal, true);
    signal.throwIfAborted();
    const files = new Map(plan.files.filter(file => file.kind === 'terrain').map(file => [file.url, file]));
    return expected.every(file => {
      const saved = files.get(file.url);
      return saved?.sha256 === file.sha256 && saved?.byteLength === file.byteLength;
    });
  } catch { signal.throwIfAborted(); return false; }
}
