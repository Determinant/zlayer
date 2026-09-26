import type { RadarContours } from '@zlayer/contracts';
import type { Feature, Polygon } from 'geojson';

/** Keep native contours intact while giving the tile index spatially local features. */
export function radarFeatures(scans: readonly RadarContours[]): Feature<Polygon, { dbz: number }>[] {
  return scans.flatMap(scan => scan.features.flatMap(feature => feature.geometry.coordinates.map(coordinates => ({
    type: 'Feature', properties: feature.properties, geometry: { type: 'Polygon', coordinates },
  }))));
}
