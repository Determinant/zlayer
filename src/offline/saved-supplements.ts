import { bookUrl, isChartSupplementCatalog, type ChartSupplementCatalog, type GeoPointFeature } from '@zlayer/contracts';
import { featureIdentifiers } from '@zlayer/domain';
import { savedPlans } from './saved-plans';
import { snapshotFilesIncluded } from './plan-records';
import { cachedFileBytes } from './storage';


/** Prefer a saved airport edition whose entire book set is still present, including during failed updates. */
export async function savedAirportSupplements(feature: GeoPointFeature, revision: string): Promise<ChartSupplementCatalog | undefined> {
  const identifiers = new Set(featureIdentifiers(feature));
  const plans = await savedPlans();
  const candidates = plans.flatMap(plan => [plan, ...(plan.previous ? [plan.previous] : [])])
    .filter(plan => plan.revision === revision && snapshotFilesIncluded(plan))
    .flatMap(plan => plan.references.flatMap(reference => reference.id === 'chart-supplements' && reference.snapshot &&
      isChartSupplementCatalog(reference.snapshot, revision)
      ? [{ url: reference.url, snapshot: reference.snapshot }] : []))
    .sort((a, b) => b.snapshot.generatedAt.localeCompare(a.snapshot.generatedAt));
  for (const { url, snapshot } of candidates) {
    const airports = snapshot.airports.filter(airport => identifiers.has(airport.faaId));
    if (!airports.length) continue;
    const volumes = snapshot.volumes.filter(volume => airports.some(airport => airport.volumeId === volume.id));
    const present = await Promise.all(volumes.map(volume => cachedFileBytes({
      kind: 'pdf', url: bookUrl(volume, url), byteLength: volume.byteLength, sha256: volume.sha256,
    })));
    if (present.every(bytes => bytes !== undefined)) return { ...snapshot,
      volumes: snapshot.volumes.map(volume => ({ ...volume, url: bookUrl(volume, url) })),
    };
  }
  return undefined;
}
