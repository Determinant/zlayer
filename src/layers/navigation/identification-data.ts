import type { GeoPointFeature } from '@zlayer/contracts';
import { featureKey, normalizeNavaidType } from '@zlayer/domain';
import { fetchNavigationLayer } from '../../workspace/catalog/catalog';
import { fetchNavigation } from './api';

/** Older saved exports predate station alignment. Supplement only that missing
 * field from the same FAA cycle, using the ordinary validated/offline feed cache. */
export async function fillMissingNavaidAlignment(features: GeoPointFeature[], revision: string,
  signal?: AbortSignal): Promise<GeoPointFeature[]> {
  if (!features.some(needsAlignment)) return features;
  try {
    const layer = await fetchNavigationLayer(revision, 'navaids', signal);
    signal?.throwIfAborted();
    const current = await fetchNavigation(layer, revision, []);
    signal?.throwIfAborted();
    const alignments = new Map<string, number | undefined>();
    for (const feature of current.features) {
      const key = stationKey(feature);
      // Ambiguous source records must never supply an alignment.
      alignments.set(key, alignments.has(key) ? undefined : feature.properties.stationDeclinationDeg);
    }
    return features.map(feature => {
      const alignment = needsAlignment(feature) ? alignments.get(stationKey(feature)) : undefined;
      return alignment === undefined ? feature : { ...feature,
        properties: { ...feature.properties, stationDeclinationDeg: alignment } };
    });
  } catch {
    signal?.throwIfAborted();
    // A missing supplement must not hide the saved stations or their true bearings.
    return features;
  }
}

function needsAlignment(feature: GeoPointFeature): boolean {
  return feature.properties.stationDeclinationDeg === undefined &&
    ['VOR', 'VOR/DME', 'VORTAC'].includes(normalizeNavaidType(feature.properties.type));
}

function stationKey(feature: GeoPointFeature): string {
  const { ident, state, country, type } = feature.properties;
  return JSON.stringify([featureKey(feature), ident, state, country, normalizeNavaidType(type), feature.geometry.coordinates]);
}
