import type { Bounds } from '@zlayer/contracts';
import type { SavedBundle } from './bundle-repository';
import { partitionRegionCoverage } from './region-coverage';

/** Only explicitly saved regions contributing to the same partition as charts. */
export function visibleSavedBundles(bundles: readonly SavedBundle[], viewport: Bounds | undefined): SavedBundle[] {
  if (!viewport || !bundles.length) return [];
  const visible = new Set(partitionRegionCoverage(bundles, viewport).map(part => part.bundle));
  return bundles.filter(bundle => visible.has(bundle));
}
