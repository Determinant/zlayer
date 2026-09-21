import type { FeatureCollectionResponse } from '@zlayer/contracts';
import terminal from './route-departures.json';

// Synthetic coordinates; the procedure topology is the published 2026-09-03 TRUKN2 record.
export const departureNavigation: FeatureCollectionResponse = {
  type: 'FeatureCollection', meta: { layer: 'fixes', revision: '2026-09-03', returned: 10, truncated: false },
  features: [...new Map(terminal.procedures.flatMap(procedure => procedure.routes.flatMap(route => route.points))
    .map(point => [point.ident, point])).values()].map((point, index) => ({
    type: 'Feature', id: `fix:${point.ident}`, geometry: { type: 'Point', coordinates: [-122.3 + index * .03, 37.7 + index * .025] },
    properties: { ident: point.ident, useCode: point.type, icaoRegion: point.icaoRegion },
  })),
};
