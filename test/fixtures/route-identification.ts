import type { FeatureCollectionResponse, GeoPointFeature } from '@zlayer/contracts';

export const identificationStations: FeatureCollectionResponse = {
  type: 'FeatureCollection', meta: { layer: 'navaids', revision: '2026-09-03', returned: 3, truncated: false },
  features: [
    ['PYE', 'Point Reyes', -122.8, 38.1], ['OSI', 'Woodside', -122.28, 37.39], ['SFO', 'San Francisco VOR', -122.373, 37.618],
  ].map(([ident, name, longitude, latitude]): GeoPointFeature => ({ type: 'Feature', id: `navaid:${ident}`,
    properties: { ident: String(ident), name: String(name), kind: 'navaid', type: 'VOR/DME', stationDeclinationDeg: 13,
      dataRevision: '2026-09-03', status: 'OPERATIONAL' },
    geometry: { type: 'Point', coordinates: [Number(longitude), Number(latitude)] } })),
};
export const identificationFixes: FeatureCollectionResponse = {
  type: 'FeatureCollection', meta: { layer: 'fixes', revision: '2026-09-03', returned: 1, truncated: false },
  features: [{ type: 'Feature', id: 'fix:BAYPT', properties: { ident: 'BAYPT', name: 'Bay point', kind: 'fix' },
    geometry: { type: 'Point', coordinates: [-122.376, 37.618] } }],
};
