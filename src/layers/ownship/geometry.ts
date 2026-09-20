import type { FeatureCollection, Feature, Geometry } from 'geojson';
import type { OwnshipSnapshot } from './layer';
import { destination, projectedTrack } from './position';

export function ownshipGeometry({ enabled, state, fix, turnRate }: OwnshipSnapshot): FeatureCollection {
  if (!enabled || !fix) return { type: 'FeatureCollection', features: [] };
  const live = state === 'tracking';
  const point = (kind: string, coordinates: [number, number]): Feature => ({
    type: 'Feature', properties: { kind, live, track: live ? fix.track : null },
    geometry: { type: 'Point', coordinates },
  });
  const features: Feature<Geometry>[] = [point('aircraft', fix.coordinates)];
  const ring = Array.from({ length: 49 }, (_, i) => destination(fix.coordinates, i * 360 / 48, fix.accuracy));
  ring[48] = ring[0]!;
  features.push({ type: 'Feature', properties: { kind: 'accuracy', live }, geometry: { type: 'Polygon', coordinates: [ring] } });
  const trace = live ? projectedTrack(fix, turnRate) : [];
  if (trace.length) {
    features.push({ type: 'Feature', properties: { kind: 'projection' }, geometry: { type: 'LineString', coordinates: trace } });
  }
  return { type: 'FeatureCollection', features };
}
