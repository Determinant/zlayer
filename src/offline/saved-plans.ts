import { isCatalogResponse, isRecord, type CatalogResponse } from '@zlayer/contracts';
import { offlineRecords } from '../core/storage/database';
import type { DownloadPlan } from './downloads';
import { isDownloadPlan, REGION_PREFIX } from './plan-records';
import { restoreDownloadPlan } from './compatibility/legacy-plans';

export async function savedPlans(requireReadable = false): Promise<DownloadPlan[]> {
  const { plans, issues } = await savedPlanInventory();
  if (requireReadable && issues.length) throw new Error(issues[0]!.message);
  return plans;
}

export type SavedRegionIssue = { planId?: string; message: string };

/** Browsing restores healthy records independently. Destructive callers use savedPlans(true). */
export async function savedPlanInventory(): Promise<{ plans: DownloadPlan[]; issues: SavedRegionIssue[] }> {
  const records = await offlineRecords(REGION_PREFIX);
  let catalogs: Promise<CatalogResponse[]> | undefined;
  const plans: DownloadPlan[] = [], issues: SavedRegionIssue[] = [];
  for (const value of records) {
    try {
      if (isDownloadPlan(value)) { plans.push(value); continue; }
      catalogs ??= offlineRecords('catalog:').then(values => values.filter(isCatalogResponse));
      const plan = restoreDownloadPlan(value, await catalogs, location.href);
      if (!plan) throw new Error('Unrecognized selection metadata');
      plans.push(plan);
    } catch {
      issues.push({ ...(isRecord(value) && typeof value.id === 'string' ? { planId: value.id } : {}),
        message: 'A saved region could not be read. Its files have been kept.' });
    }
  }
  return { plans, issues };
}
