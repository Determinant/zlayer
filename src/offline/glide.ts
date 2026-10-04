import type { DownloadPlan } from './downloads';
import { readBundleSnapshot } from './bundle-snapshots';
import { regionGlideFiles } from '../layers/glide/data';

export async function prepareRegionGlide(plan: DownloadPlan, signal: AbortSignal): Promise<DownloadPlan> {
  if (!plan.glide) return plan;
  const source = (plan.catalog ?? await readBundleSnapshot(plan))?.glide;
  if (!source || !plan.bounds?.length) throw new Error('Glide metadata is missing. Reload feeds and use Update to latest for this region.');
  const files = await regionGlideFiles(plan.bounds, plan.regionId, source, location.href, signal);
  return { ...plan, files: [...plan.files.filter(file => file.kind !== 'glide'), ...files] };
}
export async function glideFilesIncluded(plan: DownloadPlan, signal = new AbortController().signal): Promise<boolean> {
  signal.throwIfAborted();
  if (!plan.glide) return true;
  const source = (plan.catalog ?? await readBundleSnapshot(plan))?.glide;
  if (!source || !plan.bounds?.length) return false;
  try {
    const expected = await regionGlideFiles(plan.bounds, plan.regionId, source, location.href, signal, true);
    const saved = new Map(plan.files.filter(file => file.kind === 'glide').map(file => [file.url, file]));
    return expected.every(file => saved.get(file.url)?.sha256 === file.sha256 && saved.get(file.url)?.byteLength === file.byteLength);
  } catch { signal.throwIfAborted(); return false; }
}
