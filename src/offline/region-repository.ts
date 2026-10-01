import type { DownloadPlan } from './downloads';
import { readOfflineRecord, writeOfflineRecord, writeOfflineRecords } from '../core/storage/database';
import { persistBundleSnapshot } from './bundle-snapshots';
import { isDownloadPlan, REGION_PREFIX } from './plan-records';
import { savedPlans } from './saved-plans';
import { activatedPlan, stagedPlan, supersededRegionPlans } from './region-selection';
import { notifyOfflineInventory } from './inventory-events';

// Callers hold the region download Web Lock through staging, transfer and activation.
export async function stageRegion(plan: DownloadPlan): Promise<DownloadPlan> {
  const next = await persistBundleSnapshot(plan);
  const stored = await readOfflineRecord(`${REGION_PREFIX}${plan.id}`);
  const staged = stagedPlan(next, isDownloadPlan(stored) ? stored : undefined);
  await writeOfflineRecord(`${REGION_PREFIX}${plan.id}`, staged);
  return staged;
}

export async function activateRegion(plan: DownloadPlan): Promise<DownloadPlan> {
  const active = activatedPlan(await persistBundleSnapshot(plan));
  const obsolete = supersededRegionPlans(active, await savedPlans(true));
  // One commit selects the verified replacement and retires earlier editions.
  // Until it succeeds, the old records still own every saved file. Afterwards,
  // unused bytes are temporary cache: open views and normal cleanup own their life.
  await writeOfflineRecords([
    [`${REGION_PREFIX}${active.id}`, active],
    ...obsolete.map(plan => [`${REGION_PREFIX}${plan.id}`, undefined] as const),
  ], { requireKey: `${REGION_PREFIX}${active.id}` });
  notifyOfflineInventory();
  return active;
}

export async function forgetRegion(id: string): Promise<void> {
  await writeOfflineRecord(`${REGION_PREFIX}${id}`, undefined);
  notifyOfflineInventory();
}
