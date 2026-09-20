import type { Bounds, CatalogResponse } from '@zlayer/contracts';
import type { DownloadPlan } from './downloads';
import { savedPlanInventory, type SavedRegionIssue } from './saved-plans';
import { cachedFileBytes } from './storage';
import { regionReferencesReady } from './reference-readiness';
import { readBundleSnapshot, bundleSelectionKey } from './bundle-snapshots';
import { OFFLINE_REGIONS } from './regions';
import { createLegacyBundleMigration } from './compatibility/legacy-bundles';
import { isActivated } from './region-selection';

export type SavedBundle = { plan: DownloadPlan; catalog: CatalogResponse; bounds: Bounds[]; key: string; unavailable?: boolean };
export type SavedBundleInventory = { bundles: SavedBundle[]; issues: SavedRegionIssue[] };

/** Restore saved selections through the persistence boundary, adopting eligible legacy records.
 * A pending update never replaces its previous complete snapshot merely because metadata arrived. */
export async function restoreSavedBundles(verifyAvailability = true): Promise<SavedBundleInventory> {
  const { plans, issues } = await savedPlanInventory();
  const legacy = createLegacyBundleMigration();
  const snapshots = new Map<string, Promise<CatalogResponse | undefined>>();
  const available = availabilityCheck();
  const result: SavedBundle[] = [];
  for (const root of plans) {
    try {
      for (const plan of [root, ...(root.previous ? [root.previous] : [])]) {
        if (!isActivated(plan)) continue;
        const region = OFFLINE_REGIONS.find(region => region.id === plan.regionId);
        const bounds = plan.bounds ?? region?.bounds;
        if (!bounds?.length || !plan.files.length) continue;
        if (plan.snapshotId && !snapshots.has(plan.snapshotId)) snapshots.set(plan.snapshotId, readBundleSnapshot(plan));
        const catalog = plan.snapshotId ? await snapshots.get(plan.snapshotId) : await legacy.findCatalog(plan);
        if (!catalog?.chartPackages) {
          if (plan.completedAt) throw new Error('Saved catalog metadata is unavailable');
          continue;
        }
        let complete: boolean | undefined;
        try { complete = verifyAvailability || !plan.completedAt ? await available(plan) : undefined; }
        catch (error) {
          if (!plan.completedAt) throw error;
          issues.push(regionIssue(root, error));
        }
        // Activation survives later browser eviction. Reads must still request this
        // edition's exact identities; only legacy adoption requires present bytes.
        if (complete === false && !plan.completedAt) continue;
        const snapshotId = plan.snapshotId ?? await legacy.adopt(root, plan, catalog, bounds);
        result.push({ plan, catalog, bounds, key: await bundleSelectionKey(plan, snapshotId),
          ...(complete !== undefined ? { unavailable: !complete } : {}) });
        break;
      }
    } catch (error) { issues.push(regionIssue(root, error)); }
  }
  // Most recent complete edition wins overlapping saved coverage. Stable IDs
  // resolve ties; a partially downloaded newer edition never takes precedence.
  return { bundles: result.sort(compareBundles), issues };
}

/** Committed metadata needs no dependency reads. Legacy adoption still requires verification. */
export const restoreSavedBundleMetadata = () => restoreSavedBundles(false);

/** Availability is health information; eviction never changes the selected edition. */
export async function checkSavedBundleAvailability(bundles: readonly SavedBundle[]): Promise<SavedBundleInventory> {
  const available = availabilityCheck();
  const checked: SavedBundle[] = [];
  const issues: SavedRegionIssue[] = [];
  for (const bundle of bundles) {
    try { checked.push({ ...bundle, unavailable: !await available(bundle.plan) }); }
    catch (error) { checked.push(bundle); issues.push(regionIssue(bundle.plan, error)); }
  }
  return { bundles: checked, issues };
}

/** Failed reads cannot revoke an already known selection. Successful absence can. */
export function retainFailedBundleOwnership(inventory: SavedBundleInventory, previous: readonly SavedBundle[]): SavedBundle[] {
  const restored = new Set(inventory.bundles.map(bundle => bundle.plan.id));
  const retained = previous.filter(bundle => !restored.has(bundle.plan.id) &&
    inventory.issues.some(issue => issue.planId === undefined || issue.planId === bundle.plan.id));
  return [...inventory.bundles, ...retained].sort(compareBundles);
}

function compareBundles(a: SavedBundle, b: SavedBundle): number {
  return b.catalog.revision.localeCompare(a.catalog.revision) ||
    b.catalog.generatedAt.localeCompare(a.catalog.generatedAt) ||
    (b.plan.completedAt ?? 0) - (a.plan.completedAt ?? 0) || a.plan.id.localeCompare(b.plan.id);
}

function regionIssue(plan: DownloadPlan, error: unknown): SavedRegionIssue {
  return { planId: plan.id, message: `${plan.title}: ${error instanceof Error ? error.message : 'Storage unavailable'}` };
}

function availabilityCheck() {
  const files = new Map<string, Promise<number | undefined>>();
  const references = new Map<string, Promise<boolean>>();
  return async (plan: DownloadPlan): Promise<boolean> => {
    for (let offset = 0; offset < plan.files.length; offset += 4) {
      const present = await Promise.all(plan.files.slice(offset, offset + 4).map(file => {
        const key = JSON.stringify(file);
        if (!files.has(key)) files.set(key, cachedFileBytes(file));
        return files.get(key)!;
      }));
      if (present.some(value => value === undefined)) return false;
    }
    return regionReferencesReady(plan, references);
  };
}
