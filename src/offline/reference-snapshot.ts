import type { CatalogResponse } from '@zlayer/contracts';
import type { ReferenceResource } from '../core/data/references';
import type { DownloadPlan } from './downloads';
import { readBundleSnapshot } from './bundle-snapshots';

/** Activation and product readers must use the same verified reference records. */
export async function withReferenceSnapshot(plan: DownloadPlan, references: ReferenceResource[]): Promise<DownloadPlan> {
  const catalog = plan.catalog ?? await readBundleSnapshot(plan);
  if (!catalog) throw new Error('Download catalog metadata is unavailable');
  const pinnedNavigation = (resource: CatalogResponse['navigation'][number]) => {
    const reference = references.find(reference => reference.id === resource.id);
    if (reference && reference.id !== 'unverified') return reference as typeof resource;

    // Schema 3 publishes IFR fixes and VFR waypoints in one export. The plan
    // captures its bytes once under "fixes", while both catalog views need the
    // same saved URL and identity with their own filtering metadata intact.
    const fixes = catalog.navigation.find(layer => layer.id === 'fixes');
    const savedFixes = references.find(reference => reference.id === 'fixes');
    if (resource.id === 'vfr-waypoints' && resource.subset === 'vfr-waypoints' &&
      fixes?.subset === 'other-fixes' && fixes.url === resource.url &&
      fixes.sourceCount === resource.sourceCount && fixes.jsonSha256 === resource.jsonSha256 &&
      savedFixes?.id === 'fixes' && savedFixes.jsonSha256) {
      return { ...resource, url: savedFixes.url, jsonSha256: savedFixes.jsonSha256 };
    }
    throw new Error(`Missing saved reference: ${resource.id}`);
  };
  const pinned = <R extends { id: string }>(resource: R): R => {
    const reference = references.find(reference => reference.id === resource.id);
    if (!reference || reference.id === 'unverified') throw new Error(`Missing saved reference: ${resource.id}`);
    return reference as unknown as R;
  };
  const snapshot: CatalogResponse = { ...catalog, navigation: catalog.navigation.map(pinnedNavigation),
    ...(catalog.airways ? { airways: pinned(catalog.airways) } : {}),
    ...(catalog.preferredRoutes ? { preferredRoutes: pinned(catalog.preferredRoutes) } : {}),
    ...(catalog.terminalProcedures ? { terminalProcedures: pinned(catalog.terminalProcedures) } : {}),
    ...(catalog.routeHistory ? { routeHistory: pinned(catalog.routeHistory) } : {}),
    ...(catalog.procedures ? { procedures: pinned(catalog.procedures) } : {}),
  };
  return { ...plan, references, catalog: snapshot };
}
