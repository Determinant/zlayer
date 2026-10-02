import type { FeatureCollection, Feature, Geometry } from 'geojson';
import type { OwnshipSnapshot } from './layer';
import { destination, projectedTrack, usableMotion } from './position';

export function ownshipGeometry({ enabled, state, fix, turnRate, displayTrack }: OwnshipSnapshot): FeatureCollection {
  if (!enabled || !fix) return { type: 'FeatureCollection', features: [] };
  const live = state === 'tracking';
  const point = (kind: string, coordinates: [number, number]): Feature => ({
    type: 'Feature', properties: { kind, live, track: live ? displayTrack : null },
    geometry: { type: 'Point', coordinates },
  });
  const features: Feature<Geometry>[] = [point('aircraft', fix.coordinates)];
  const ring = Array.from({ length: 49 }, (_, i) => destination(fix.coordinates, i * 360 / 48, fix.accuracy));
  ring[48] = ring[0]!;
  features.push({ type: 'Feature', properties: { kind: 'accuracy', live }, geometry: { type: 'Polygon', coordinates: [ring] } });
  const trace = live ? projectedTrack(fix, turnRate, displayTrack) : [];
  if (trace.length) {
    features.push({ type: 'Feature', properties: { kind: 'projection' }, geometry: { type: 'LineString', coordinates: trace } });
  }
  return { type: 'FeatureCollection', features };
}

/** Source timestamps, altitude and velocity provenance do not change map pixels. */
export function sameOwnshipGeometry(a: OwnshipSnapshot, b: OwnshipSnapshot): boolean {
  const left = a.enabled ? a.fix : null, right = b.enabled ? b.fix : null;
  if (!left || !right) return left === right;
  const live = a.state === 'tracking';
  if (live !== (b.state === 'tracking') || left.coordinates[0] !== right.coordinates[0]
    || left.coordinates[1] !== right.coordinates[1] || left.accuracy !== right.accuracy) return false;
  if (!live) return true;
  if (a.displayTrack !== b.displayTrack) return false;
  const leftProjects = usableMotion(left), rightProjects = usableMotion(right);
  return leftProjects === rightProjects && (!leftProjects
    || (left.speed === right.speed && (a.turnRate ?? 0) === (b.turnRate ?? 0)));
}
