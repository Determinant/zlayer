import type { CatalogResponse } from '@zlayer/contracts';
import type { ReferenceResource } from '../core/data/references';
import type { DownloadPlan } from './downloads';
import { readBundleSnapshot } from './bundle-snapshots';

/** Activation and product readers must use the same verified reference records. */
export async function withReferenceSnapshot(plan: DownloadPlan, references: ReferenceResource[]): Promise<DownloadPlan> {
  const catalog = plan.catalog ?? await readBundleSnapshot(plan);
  if (!catalog) throw new Error('Download catalog metadata is unavailable');
  const pinned = <R extends { id: string }>(resource: R): R => {
    const reference = references.find(reference => reference.id === resource.id);
    if (!reference || reference.id === 'unverified') throw new Error(`Missing saved reference: ${resource.id}`);
    return reference as unknown as R;
  };
  const snapshot: CatalogResponse = { ...catalog, navigation: catalog.navigation.map(pinned),
    ...(catalog.airways ? { airways: pinned(catalog.airways) } : {}),
    ...(catalog.preferredRoutes ? { preferredRoutes: pinned(catalog.preferredRoutes) } : {}),
    ...(catalog.terminalProcedures ? { terminalProcedures: pinned(catalog.terminalProcedures) } : {}),
    ...(catalog.routeHistory ? { routeHistory: pinned(catalog.routeHistory) } : {}),
    ...(catalog.procedures ? { procedures: pinned(catalog.procedures) } : {}),
  };
  return { ...plan, references, catalog: snapshot };
}
