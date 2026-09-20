import type { FeatureCollection, LineString, Point } from 'geojson';
import { MercatorCoordinate, type GeoJSONSource, type Map as MapLibreMap } from 'maplibre-gl';
import type { GeoPointFeature } from '@zlayer/contracts';
import { NEARBY_VOR_MAP_LIMIT, type NearbyVor } from '@zlayer/domain';
import { removeLayerResources, type MapLayerModule } from '../../core/map/layer';
import { formatNavaidRadial } from './nearby-navaids-format';

export type NavaidIdentification = { point: GeoPointFeature; stations: readonly NearbyVor[] } | undefined;
type IdentificationProjection = Pick<MapLibreMap, 'project' | 'unproject' | 'getCenter'>;
const SOURCE = 'navaid-identification';
const COLOR = '#005a9c';
const LAYERS = ['navaid-id-halo', 'navaid-id-lines', 'navaid-id-points', 'navaid-id-labels', 'navaid-id-references'];

export function identificationGeoJson(input: NavaidIdentification,
  projection?: IdentificationProjection): FeatureCollection<LineString | Point> {
  if (!input?.stations.length) return { type: 'FeatureCollection', features: [] };
  const [longitude, latitude] = input.point.geometry.coordinates;
  // Perspective projection must use the visible world copy for both endpoints.
  const center = projection?.getCenter().lng ?? longitude;
  const point: [number, number] = [longitude + 360 * Math.round((center - longitude) / 360), latitude];
  const stations = input.stations.slice(0, NEARBY_VOR_MAP_LIMIT);
  return { type: 'FeatureCollection', features: [
    ...stations.flatMap((reference, index): FeatureCollection<LineString | Point>['features'] => {
      const { feature, distanceNm } = reference;
      const [longitude, latitude] = feature.geometry.coordinates;
      // Draw the short connection across the antimeridian in the point's world copy.
      const station: [number, number] = [longitude + 360 * Math.round((point[0] - longitude) / 360), latitude];
      const label = referencePosition(station, point, projection);
      // Use the ASCII placeholder supported by the bundled offline map glyphs.
      const properties = { reference: `${formatNavaidRadial(reference, '-')} · ${distanceNm.toFixed(1)} NM`,
        labelOffset: referenceOffset(stations, index) };
      return [
        { type: 'Feature', properties,
          geometry: { type: 'LineString', coordinates: [station, point] } },
        // Point placement keeps the reference visible even on a short line.
        { type: 'Feature', properties: { ...properties, rotation: label.rotation },
          geometry: { type: 'Point', coordinates: label.coordinates } },
        { type: 'Feature', properties: { ident: feature.properties.ident, target: false },
          geometry: { type: 'Point', coordinates: station } },
      ];
    }),
    { type: 'Feature', properties: { target: true }, geometry: { type: 'Point', coordinates: point } },
  ] };
}

function referencePosition(from: [number, number], to: [number, number],
  projection?: IdentificationProjection) {
  const project = (point: [number, number]) => projection?.project(point) ??
    MercatorCoordinate.fromLngLat([point[0], Math.max(-85.051129, Math.min(85.051129, point[1]))]);
  const a = project(from), b = project(to);
  const x = (a.x + b.x) / 2, y = (a.y + b.y) / 2;
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

/** An ephemeral reference overlay; it does not participate in map selection. */
export function createNavaidIdentificationLayer(): MapLayerModule<NavaidIdentification> {
  let map: MapLibreMap | undefined;
  let input: NavaidIdentification;
  const refresh = () => (map?.getSource(SOURCE) as GeoJSONSource | undefined)?.setData(identificationGeoJson(input, map));
  const move = () => { if (input?.stations.length) refresh(); };
  return {
    id: SOURCE, slot: 'route', foregroundLayerIds: ['navaid-id-points', 'navaid-id-labels', 'navaid-id-references'],
    mount(target) {
      map = target;
      map.addSource(SOURCE, { type: 'geojson', data: identificationGeoJson(input, map) });
      map.addLayer({ id: 'navaid-id-halo', type: 'line', source: SOURCE, filter: ['==', '$type', 'LineString'],
        // A continuous opaque casing isolates the thin dark-blue dashes from busy charts.
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ffffff', 'line-opacity': 1, 'line-width': 6 } });
      map.addLayer({ id: 'navaid-id-lines', type: 'line', source: SOURCE, filter: ['==', '$type', 'LineString'],
        paint: { 'line-color': COLOR, 'line-width': 2, 'line-dasharray': [4, 2] } });
      map.addLayer({ id: 'navaid-id-points', type: 'circle', source: SOURCE,
        filter: ['all', ['==', '$type', 'Point'], ['has', 'target']],
        paint: { 'circle-radius': ['case', ['get', 'target'], 7, 5], 'circle-color': COLOR,
          'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3 } });
      map.addLayer({ id: 'navaid-id-labels', type: 'symbol', source: SOURCE,
        filter: ['all', ['==', '$type', 'Point'], ['==', 'target', false]],
        layout: { 'text-field': ['get', 'ident'], 'text-font': ['Noto Sans Bold'], 'text-size': 13,
          'text-anchor': 'left', 'text-offset': [0.8, 0], 'text-allow-overlap': true },
        paint: { 'text-color': COLOR, 'text-halo-color': '#ffffff', 'text-halo-width': 2.5 } });
      map.addLayer({ id: 'navaid-id-references', type: 'symbol', source: SOURCE,
        filter: ['all', ['==', '$type', 'Point'], ['has', 'reference']],
        layout: { 'text-field': ['get', 'reference'], 'text-max-width': 24,
          'text-rotation-alignment': 'viewport', 'text-rotate': ['get', 'rotation'],
          'text-font': ['Noto Sans Bold'], 'text-size': 12, 'text-offset': ['get', 'labelOffset'],
          'text-allow-overlap': true, 'text-ignore-placement': true },
        paint: { 'text-color': COLOR, 'text-halo-color': '#ffffff', 'text-halo-width': 2.5 } });
      map.on('move', move);
    },
    update(next) {
      input = next;
      refresh();
    },
    unmount() {
      if (map) {
        map.off('move', move);
        removeLayerResources(map, LAYERS, [SOURCE]);
      }
      map = undefined;
    },
  };
}
