import type { FeatureCollection, LineString, Point } from 'geojson';
import { MercatorCoordinate, type ExpressionSpecification, type Map as MapLibreMap } from 'maplibre-gl';
import type { GeoPointFeature } from '@zlayer/contracts';
import { greatCircleCoordinates, NEARBY_VOR_MAP_LIMIT, radialReference, type NearbyVor, type RadialPosition } from '@zlayer/domain';
import { removeLayerResources, type MapLayerModule } from '../../core/map/layer';
import { createSourceSubmission } from '../../core/map/source-submission';
import { REFERENCE_LINE_COLOR as COLOR, REFERENCE_LINE_HALO, REFERENCE_LINE_PAINT } from '../../core/map/reference-line';
import { formatNavaidRadial, formatNavaidTrueBearing } from './nearby-navaids-format';

export type NavaidIdentification = {
  point: GeoPointFeature; stations: readonly NearbyVor[]; radial?: Omit<RadialPosition, 'coordinate'> | undefined;
} | undefined;
type IdentificationProjection = Pick<MapLibreMap, 'project' | 'unproject' | 'getCenter'>;
const SOURCE = 'navaid-identification';
const LAYERS = ['navaid-id-halo', 'navaid-id-lines', 'navaid-id-points', 'navaid-id-labels', 'navaid-id-references'];
const trim: ExpressionSpecification = ['case', ['boolean', ['get', 'selected'], false], '#ffd17a', '#ffffff'];

export function identificationGeoJson(input: NavaidIdentification,
  projection?: IdentificationProjection): FeatureCollection<LineString | Point> {
  if (!input || !input.stations.length && !input.radial) return { type: 'FeatureCollection', features: [] };
  const [longitude, latitude] = input.point.geometry.coordinates;
  // Perspective projection must use the visible world copy for both endpoints.
  const center = projection?.getCenter().lng ?? longitude;
  const point: [number, number] = [longitude + 360 * Math.round((center - longitude) / 360), latitude];
  const stations = input.stations.slice(0, NEARBY_VOR_MAP_LIMIT)
    .filter(station => !input.radial || JSON.stringify(radialReference(station.feature)) !== JSON.stringify(input.radial.reference))
    .map(station => ({ ...station, selected: false }));
  // Always draw the selected snapshot, even outside the ranked list or offline.
  // Append it last so its yellow trim stays visible over nearby references.
  if (input.radial) {
    const { reference, radial, distanceNm } = input.radial;
    stations.push({ feature: { type: 'Feature', properties: { ident: reference.ident },
      geometry: { type: 'Point', coordinates: reference.coordinate } },
      radial, distanceNm, trueBearing: (radial + reference.declination + 360) % 360, mon: false, selected: true });
  }
  return { type: 'FeatureCollection', features: [
    ...stations.flatMap((reference, index): FeatureCollection<LineString | Point>['features'] => {
      const { feature, distanceNm } = reference;
      const [longitude, latitude] = feature.geometry.coordinates;
      // Draw the short connection across the antimeridian in the point's world copy.
      const station: [number, number] = [longitude + 360 * Math.round((point[0] - longitude) / 360), latitude];
      let previousLongitude = station[0];
      const coordinates = greatCircleCoordinates(station, point).map(([longitude, latitude]): [number, number] => {
        previousLongitude = longitude + 360 * Math.round((previousLongitude - longitude) / 360);
        return [previousLongitude, latitude];
      });
      const middle = Math.floor((coordinates.length - 1) / 2), odd = coordinates.length % 2 === 1;
      const label = referencePosition(coordinates[odd ? middle - 1 : middle]!, coordinates[middle + 1]!, projection,
        odd ? coordinates[middle] : undefined);
      // Use the ASCII placeholder supported by the bundled offline map glyphs.
      const bearing = reference.selected && input.radial?.reference.bearing === 'true'
        ? formatNavaidTrueBearing({ trueBearing: reference.radial }, '-') : formatNavaidRadial(reference, '-');
      const properties = { selected: reference.selected, reference: `${bearing} · ${distanceNm.toFixed(1)} NM`,
        labelOffset: referenceOffset(stations, index) };
      return [
        { type: 'Feature', properties,
          geometry: { type: 'LineString', coordinates } },
        // Point placement keeps the reference visible even on a short line.
        { type: 'Feature', properties: { ...properties, rotation: label.rotation },
          geometry: { type: 'Point', coordinates: label.coordinates } },
        { type: 'Feature', properties: { ident: feature.properties.ident, target: false, selected: reference.selected },
          geometry: { type: 'Point', coordinates: station } },
      ];
    }),
    { type: 'Feature', properties: { target: true, selected: !!input.radial }, geometry: { type: 'Point', coordinates: point } },
  ] };
}

function referencePosition(from: [number, number], to: [number, number],
  projection?: IdentificationProjection, anchor?: [number, number]) {
  const project = (point: [number, number]) => projection?.project(point) ??
    MercatorCoordinate.fromLngLat([point[0], Math.max(-85.051129, Math.min(85.051129, point[1]))]);
  const a = project(from), b = project(to);
  const centerPoint = anchor ? project(anchor) : { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const { x, y } = centerPoint;
  const center = projection ? projection.unproject([x, y]) : new MercatorCoordinate(x, y).toLngLat();
  const angle = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
  return { coordinates: center.toArray(), rotation: angle > 90 ? angle - 180 : angle < -90 ? angle + 180 : angle };
}

/** Separate labels when several references approach from the same direction. */
function referenceOffset(stations: readonly NearbyVor[], index: number): [number, number] {
  const bearing = stations[index]!.trueBearing;
  const neighbors = stations.flatMap((station, other) => {
    if (other === index || bearing === null || station.trueBearing === null) return [];
    const separation = Math.abs((station.trueBearing - bearing + 540) % 360 - 180);
    return separation < 30 ? [other] : [];
  });
  if (!neighbors.length) return [0, -0.7];
  const lane = neighbors.filter(other => other < index).length;
  return [0, lane === 1 ? 1.3 : -0.7 - lane * 1.5];
}

// Ignore sub-millimeter projection roundoff during otherwise unchanged pans.
const geometryIdentity = (data: FeatureCollection) => JSON.stringify(data,
  (_key, value: unknown) => typeof value === 'number' ? Math.round(value * 1e9) / 1e9 : value);

/** An ephemeral reference overlay; it does not participate in map selection. */
export function createNavaidIdentificationLayer(): MapLayerModule<NavaidIdentification> {
  let map: MapLibreMap | undefined;
  let input: NavaidIdentification;
  let submitted = '', pending = false, dirty = false;
  let submission: ReturnType<typeof createSourceSubmission> | undefined;
  const refresh = () => {
    if (!map || !submission) return;
    dirty = true;
    if (pending) return;
    dirty = false;
    const data = identificationGeoJson(input, map), identity = geometryIdentity(data);
    if (identity === submitted) return;
    if (!map.getSource(SOURCE)) return;
    submitted = identity; pending = true;
    const source = submission, version = source.begin();
    // Keep at most one worker submission active; its successor uses the latest camera.
    void source.submit(version, data)
      .catch(error => source.reject(version, error))
      .finally(() => {
        if (submission !== source) return;
        pending = false;
        if (dirty) refresh();
      });
  };
  const move = () => { if (input && (input.stations.length || input.radial)) refresh(); };
  return {
    id: SOURCE, slot: 'annotation', lineLayerIds: ['navaid-id-halo', 'navaid-id-lines'],
    foregroundLayerIds: ['navaid-id-points', 'navaid-id-labels', 'navaid-id-references'],
    mount(target) {
      map = target;
      const data = identificationGeoJson(input, map);
      submitted = geometryIdentity(data);
      submission = createSourceSubmission(map, SOURCE, () => {
        // Retain the outstanding worker call; retry on the next input/camera update.
        submitted = ''; dirty = false;
      });
      submission.begin();
      map.addSource(SOURCE, { type: 'geojson', data });
      map.addLayer({ id: 'navaid-id-halo', type: 'line', source: SOURCE, filter: ['==', '$type', 'LineString'],
        ...REFERENCE_LINE_HALO, paint: { ...REFERENCE_LINE_HALO.paint, 'line-color': trim } });
      map.addLayer({ id: 'navaid-id-lines', type: 'line', source: SOURCE, filter: ['==', '$type', 'LineString'],
        paint: REFERENCE_LINE_PAINT });
      map.addLayer({ id: 'navaid-id-points', type: 'circle', source: SOURCE,
        filter: ['all', ['==', '$type', 'Point'], ['has', 'target']],
        paint: { 'circle-radius': ['case', ['get', 'target'], 7, 5], 'circle-color': COLOR,
          'circle-stroke-color': trim, 'circle-stroke-width': 3 } });
      map.addLayer({ id: 'navaid-id-labels', type: 'symbol', source: SOURCE,
        filter: ['all', ['==', '$type', 'Point'], ['==', 'target', false]],
        layout: { 'text-field': ['get', 'ident'], 'text-font': ['Noto Sans Bold'], 'text-size': 13,
          'text-anchor': 'left',
          'text-offset': ['case', ['get', 'selected'], ['literal', [0.8, -1.2]], ['literal', [0.8, 0]]],
          'text-allow-overlap': true },
        paint: { 'text-color': COLOR, 'text-halo-color': trim, 'text-halo-width': 2.5 } });
      map.addLayer({ id: 'navaid-id-references', type: 'symbol', source: SOURCE,
        filter: ['all', ['==', '$type', 'Point'], ['has', 'reference']],
        layout: { 'text-field': ['get', 'reference'], 'text-max-width': 24,
          'text-rotation-alignment': 'viewport', 'text-rotate': ['get', 'rotation'],
          'text-font': ['Noto Sans Bold'], 'text-size': 12, 'text-offset': ['get', 'labelOffset'],
          'text-allow-overlap': true, 'text-ignore-placement': true },
        paint: { 'text-color': COLOR, 'text-halo-color': trim, 'text-halo-width': 2.5 } });
      map.on('move', move);
    },
    update(next) {
      if (input === next && submitted) return;
      input = next;
      refresh();
    },
    unmount() {
      submission?.destroy(); submission = undefined;
      pending = false; dirty = false; submitted = '';
      if (map) {
        map.off('move', move);
        removeLayerResources(map, LAYERS, [SOURCE]);
      }
      map = undefined;
    },
  };
}
