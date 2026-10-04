import type { Bounds, GlideSource, GlideRegionReference } from '@zlayer/contracts';
import { jsonIdentity } from '../../core/data/json-identity';
import { glideRegionReference } from './landing-regions';
import { browsingCatalog, regionalBundles, type CatalogReadSource } from '../../workspace/read-context';

export type LandingRegion = { id: string; bounds: Bounds[] };
export type LandingScope = { include?: LandingRegion[]; exclude: LandingRegion[] };
export type LandingPackageSource = { source: GlideSource; regions?: GlideRegionReference[]; scope: LandingScope };
export type LandingSources = { packages: LandingPackageSource[]; legacyScope?: LandingScope };
/** Ownership follows the same state masks as charts, independently of cache health. */
export function landingSources(catalog: CatalogReadSource | undefined, base: string): LandingSources | undefined {
  if (!catalog) return undefined;
  const packages: LandingPackageSource[] = [], claimed: LandingRegion[] = [];
  let previousKey: string | undefined;
  for (const bundle of regionalBundles(catalog)) {
    const source = bundle.catalog.glide;
    if (!bundle.plan.glide || !source) continue;
    const key = jsonIdentity(source), region = { id: bundle.plan.regionId, bounds: bundle.bounds };
    const reference = glideRegionReference(source, region.id, region.bounds), previous = packages.at(-1);
    // Consecutive regions of one release share a single root in worker messages.
    if (key === previousKey && previous && reference && previous.regions) {
      previous.scope.include!.push(region); previous.regions.push(reference);
    } else packages.push({ source: { ...source, root: new URL(source.root, base).href },
      ...(reference ? { regions: [reference] } : {}), scope: { include: [region], exclude: [...claimed] } });
    previousKey = key; claimed.push(region);
  }
  const source = browsingCatalog(catalog).glide;
  if (source) packages.push({ source: { ...source, root: new URL(source.root, base).href }, scope: { exclude: claimed } });
  return { packages, ...(!source ? { legacyScope: { exclude: claimed } } : {}) };
}
