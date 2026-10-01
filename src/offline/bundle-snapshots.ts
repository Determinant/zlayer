import { isCatalogResponse, type CatalogResponse } from '@zlayer/contracts';
import { readOfflineRecord, writeOfflineRecord, offlineRecordKeys, writeOfflineRecords } from '../core/storage/database';
import type { DownloadPlan } from './downloads';
import { planMetadata } from './region-selection';

const PREFIX = 'bundle-snapshot:';

export async function persistBundleSnapshot(plan: DownloadPlan): Promise<DownloadPlan> {
  const { catalog, ...next } = planMetadata(plan);
  if (!catalog) return next;
  if (!isCatalogResponse(catalog) || catalog.revision !== plan.revision) throw new Error('Download catalog does not match its edition');
  const snapshotId = await metadataIdentity(catalog);
  await writeOfflineRecord(`${PREFIX}${snapshotId}`, catalog);
  return { ...next, snapshotId };
}

/** The caller holds the region mutation lock and supplies a fully readable
 * inventory. Active, staged and previous plans all retain their metadata. Open
 * views already own their loaded catalog; they do not reopen snapshot records. */
export async function pruneBundleSnapshots(plans: readonly DownloadPlan[]): Promise<void> {
  // Older open app versions can write migration snapshots before taking the
  // region lock. Defer reclamation until every legacy owner has been adopted.
  if (plans.some(plan => !plan.snapshotId || (plan.previous && !plan.previous.snapshotId))) return;
  const retained = new Set(plans.flatMap(plan => [plan.snapshotId, plan.previous?.snapshotId])
    .filter(id => id !== undefined).map(id => `${PREFIX}${id}`));
  const obsolete = (await offlineRecordKeys(PREFIX)).filter(key => !retained.has(key));
  if (obsolete.length) await writeOfflineRecords(obsolete.map(key => [key, undefined] as const));
}

/** Catalogs are shared nationally; regional supplement targets and file choices
 * also identify a selection. Health and transfer progress do not. */
export function bundleSelectionKey(plan: DownloadPlan, snapshotId: string | undefined): Promise<string> {
  return metadataIdentity([snapshotId, plan.id, plan.bounds, plan.files, plan.references, plan.supplementTargets]);
}

async function metadataIdentity(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function readBundleSnapshot(plan: DownloadPlan): Promise<CatalogResponse | undefined> {
  const value = plan.snapshotId ? await readOfflineRecord(`${PREFIX}${plan.snapshotId}`) : plan.catalog;
  if (!isCatalogResponse(value) || value.revision !== plan.revision) return undefined;
  // Missing historical identities cannot be inferred from the current server.
  // Preserve legacy cached reads, but require an explicit update after eviction.
  const saved = <R extends { jsonSha256?: string }>(resource: R): R =>
    resource.jsonSha256 ? resource : { ...resource, cacheOnly: true };
  return { ...value, navigation: value.navigation.map(saved),
    ...(value.airways ? { airways: saved(value.airways) } : {}),
    ...(value.preferredRoutes ? { preferredRoutes: saved(value.preferredRoutes) } : {}),
    ...(value.terminalProcedures ? { terminalProcedures: saved(value.terminalProcedures) } : {}),
    ...(value.routeHistory ? { routeHistory: saved(value.routeHistory) } : {}),
    ...(value.procedures ? { procedures: saved(value.procedures) } : {}),
  };
}
