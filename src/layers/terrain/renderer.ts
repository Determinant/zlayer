import type { Map as MapLibreMap, GeoJSONSource, ExpressionSpecification } from 'maplibre-gl';
import type { TerrainLabel } from './contours';
import type { TerrainIsoline } from './isolines';
import { terrainColor, TERRAIN_FILL_OPACITY, TERRAIN_LINE_COLOR, TERRAIN_LINE_OPACITY } from './palette';
import { BAND_OFFSET, BAND_UNIT, CLEARANCE_COLORS, CLEARANCE_CUTOFF, clearanceColor, displayElevation } from './clearance';
import { MIN_TERRAIN_ZOOM } from './detail';
import { TERRAIN_ATTRIBUTION } from './elevation';
import { TERRAIN_LAYER_ANCHOR } from '../../core/map/layer';

export const TERRAIN_SOURCE = 'route-terrain';
export const TERRAIN_LABEL_SOURCE = 'route-terrain-labels';
export const TERRAIN_CONTOUR_SOURCE = 'route-terrain-contours';
export const TERRAIN_SOURCES = [TERRAIN_SOURCE, TERRAIN_LABEL_SOURCE, TERRAIN_CONTOUR_SOURCE];
export const TERRAIN_LAYERS = ['route-terrain-fill', 'route-terrain-outlines', 'route-terrain-contour-labels'];

export function installTerrain(map: MapLibreMap, url: string): void {
  const before = map.getLayer(TERRAIN_LAYER_ANCHOR) ? TERRAIN_LAYER_ANCHOR : undefined;
  const major: ExpressionSpecification = ['==', ['%', ['get', 'elevation'], 1000], 0];
  map.addSource(TERRAIN_SOURCE, { type: 'raster-dem', tiles: [url], tileSize: 512,
    encoding: 'custom', redFactor: 256, greenFactor: 1, blueFactor: 1 / 256, baseShift: 0,
    minzoom: MIN_TERRAIN_ZOOM, maxzoom: 13, attribution: TERRAIN_ATTRIBUTION });
  map.addSource(TERRAIN_LABEL_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addSource(TERRAIN_CONTOUR_SOURCE, { type: 'geojson', tolerance: 0.2,
    data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: TERRAIN_LAYERS[0]!, type: 'color-relief', source: TERRAIN_SOURCE,
    minzoom: MIN_TERRAIN_ZOOM, paint: { 'color-relief-opacity': 1, 'resampling': 'nearest',
      'color-relief-color': terrainFillPalette(null, 1000) } }, before);
  map.addLayer({ id: TERRAIN_LAYERS[1]!, type: 'line', source: TERRAIN_CONTOUR_SOURCE,
    minzoom: MIN_TERRAIN_ZOOM, layout: { 'line-join': 'round', 'line-cap': 'butt' },
    paint: { 'line-color': `rgb(${TERRAIN_LINE_COLOR.join(',')})`,
      'line-width': ['interpolate', ['linear'], ['zoom'],
        8, ['case', major, 1, 0.65], 10, ['case', major, 1.4, 0.9],
        12, ['case', major, 2, 1.25], 13, ['case', major, 2.4, 1.5]],
      'line-opacity': ['*', ['get', 'opacity'], TERRAIN_LINE_OPACITY] },
  }, before);
  map.addLayer({ id: TERRAIN_LAYERS[2]!, type: 'symbol', source: TERRAIN_LABEL_SOURCE,
    minzoom: MIN_TERRAIN_ZOOM,
    layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'], 'text-size': 15,
      'text-padding': 26, 'symbol-sort-key': ['-', ['get', 'elevation']], 'text-allow-overlap': false },
    paint: { 'text-color': '#4b3428', 'text-halo-color': 'rgba(255, 250, 231, 0.92)', 'text-halo-width': 1.5,
      'text-opacity': ['get', 'opacity'] },
  });
}

/** A small GPU palette recolors already loaded tiles. Each band has a transparent
 * and opaque stop; intermediate values encode only the existing corridor fade. */
export function terrainFillPalette(altitude: number | null, interval: number): ExpressionSpecification {
  const ramp: ExpressionSpecification = ['interpolate', ['linear'], ['elevation'], 0, 'rgba(0,0,0,0)', 255, 'rgba(0,0,0,0)'];
  for (let band = 1; band < 256; band++) {
    const top = (band - BAND_OFFSET) * BAND_UNIT;
    const unshaded = altitude === null ? top <= interval : altitude - top >= CLEARANCE_CUTOFF;
    const alpha = unshaded ? 0 : TERRAIN_FILL_OPACITY;
    const color = clearanceColor(altitude === null ? 0 : altitude - top);
    const rgb = altitude === null ? terrainColor(top - interval)
      : [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
    ramp.push(band * 256, 'rgba(0,0,0,0)', band * 256 + 255, `rgba(${rgb.join(',')},${alpha})`);
  }
  return ramp;
}

export function syncTerrainAltitude(map: MapLibreMap, altitude: number | null, interval: number): void {
  if (!map.getLayer(TERRAIN_LAYERS[0]!)) return;
  map.setPaintProperty(TERRAIN_LAYERS[0]!, 'color-relief-color', terrainFillPalette(altitude, interval));
  if (altitude === null) {
    map.setLayoutProperty(TERRAIN_LAYERS[2]!, 'text-field', ['get', 'label']);
    return;
  }
  const difference: ExpressionSpecification = ['-', altitude, ['get', 'displayElevation']];
  const text: ExpressionSpecification = ['concat', ['case', ['<', difference, 0], '−', '+'],
    ['number-format', ['abs', difference], { locale: 'en-US', 'max-fraction-digits': 0 }], ' ft'];
  const color: ExpressionSpecification = ['case', ['<=', difference, 0], CLEARANCE_COLORS.above,
    ['<', difference, 500], CLEARANCE_COLORS.close, ['<', difference, 1000], '#896900', '#245544'];
  map.setLayoutProperty(TERRAIN_LAYERS[2]!, 'text-field', ['format', text, { 'text-color': color },
    '\n', {}, ['get', 'label'], {}]);
}

export function syncTerrainContours(map: MapLibreMap, lines: readonly TerrainIsoline[]): void {
  (map.getSource(TERRAIN_CONTOUR_SOURCE) as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection',
    features: lines.map(line => ({ type: 'Feature', geometry: { type: 'MultiLineString', coordinates: line.coordinates },
      properties: { elevation: line.elevation, opacity: line.opacity } })),
  });
}

export function syncTerrainLabels(map: MapLibreMap, labels: readonly TerrainLabel[]): void {
  (map.getSource(TERRAIN_LABEL_SOURCE) as GeoJSONSource | undefined)?.setData({
    type: 'FeatureCollection', features: labels.map(label => ({ type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: label.coordinate },
      properties: { ...label, displayElevation: displayElevation(label.elevation, label.peak), label: label.peak
        ? `^ ~${displayElevation(label.elevation, true).toLocaleString('en-US')} ft`
        : `${label.elevation.toLocaleString('en-US')} ft` },
    })),
  });
}
