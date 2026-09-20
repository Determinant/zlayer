import type { AirwayDataResponse, FeatureCollectionResponse, PreferredRoutesData, TerminalProceduresData } from '@zlayer/contracts';
import { createRouteResolver } from '@zlayer/domain';

const metadata = { effectiveDate: '2026-09-03', source: 'synthetic removal fixture' };
export const routeRemovalAirports: FeatureCollectionResponse = {
  type: 'FeatureCollection', meta: { layer: 'airports', revision: 'test', returned: 2, truncated: false },
  features: ['KSBA', 'KSMX'].map((ident, index) => ({ type: 'Feature', id: `airport:${ident}`,
    geometry: { type: 'Point', coordinates: [-120 + index * 2, 35] },
    properties: { kind: 'airport', ident, icaoId: ident, faaId: ident.slice(1), name: `${ident} airport`, elevationFt: 13 },
  })),
};
const fixes: FeatureCollectionResponse = {
  type: 'FeatureCollection', meta: { layer: 'fixes', revision: 'test', returned: 5, truncated: false },
  features: ['ENTRY', 'TAILS', 'MID', 'EXIT', 'AFTER'].map((ident, index) => ({
    type: 'Feature', id: `fix:${ident}`, geometry: { type: 'Point', coordinates: [-121 + index * 2, 36] },
    properties: { kind: 'fix', ident, name: ident, useCode: 'WP' },
  })),
};
const navaids: FeatureCollectionResponse = {
  type: 'FeatureCollection', meta: { layer: 'navaids', revision: 'test', returned: 1, truncated: false },
  features: [{ type: 'Feature', id: 'navaid:CMA', geometry: { type: 'Point', coordinates: [-120, 34] },
    properties: { kind: 'navaid', ident: 'CMA', type: 'VOR/DME' } }],
};
const vfr: FeatureCollectionResponse = {
  type: 'FeatureCollection', meta: { layer: 'vfr-waypoints', revision: 'test', returned: 1, truncated: false },
  features: [{ type: 'Feature', id: 'vfr:VPTEST', geometry: { type: 'Point', coordinates: [-118, 34] },
    properties: { kind: 'vfr-waypoint', ident: 'VPTEST' } }],
};
const airways: AirwayDataResponse = { type: 'ZLayerAirways', metadata,
  airways: [['V1', ['ENTRY', 'TAILS', 'MID', 'EXIT']], ['V2', ['EXIT', 'AFTER']]]
    .map(([ident, points]) => {
      const path = points as string[];
      return { id: `airway:${ident}`, ident: ident as string, points: path,
        segments: path.slice(0, -1).map((from, index) => ({ sequence: index + 1, from, to: path[index + 1]!, gap: false })) };
    }),
};
const terminal: TerminalProceduresData = { type: 'ZLayerTerminalProcedures', metadata,
  procedures: (['departure', 'arrival'] as const).map(kind => {
    const ident = kind === 'departure' ? 'DEP1' : 'ARR1';
    const airport = kind === 'departure' ? 'SBA' : 'SMX';
    const points = ['ENTRY', 'TAILS', 'MID', 'EXIT'];
    return { id: ident, ident, kind, name: ident, computerCode: `${ident}.${ident}`, airports: [airport],
      routes: [{ name: ident, kind: 'body', bodySequence: 1, airports: [{ ident: airport }],
        points: points.map((ident, index) => ({ ident, sequence: index + 1, type: 'WP',
          ...(points[index + 1] ? { next: points[index + 1]! } : {}) })) }] };
  }),
};
const preferred: PreferredRoutesData = { type: 'ZLayerPreferredRoutes', metadata,
  routes: [['TEST1', 'ENTRY V1 EXIT'], ['LOOP1', 'TAILS ENTRY TAILS']].map(([designator, route], index) => ({
    id: designator!, designator: designator!, route: route!, originId: 'SBA', destinationId: 'SMX',
    routeType: 'TEC', routeNumber: index + 1, segments: [],
  })),
};

export function createRouteRemovalResolver() {
  return createRouteResolver([routeRemovalAirports, fixes, navaids, vfr], airways, terminal, preferred);
}
