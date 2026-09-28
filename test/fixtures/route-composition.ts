import type { AirwayDataResponse, FeatureCollectionResponse, PreferredRoutesData, TerminalProceduresData } from '@zlayer/contracts';

// Synthetic routes exercise nested expansions and gaps, not a published clearance.
const metadata = { effectiveDate: '2026-09-03', source: 'Composition fixture' };
export const compositionFixes: FeatureCollectionResponse = {
  type: 'FeatureCollection', meta: { layer: 'fixes', revision: metadata.effectiveDate, returned: 4, truncated: false },
  features: ['START', 'SUNOL', 'MID', 'EXIT'].map((ident, i) => ({ type: 'Feature', id: `fix:${ident}`,
    geometry: { type: 'Point', coordinates: [-122.2 + i * .05, 37.5] }, properties: { ident, icaoRegion: 'K2' } })),
};
export const compositionAirways: AirwayDataResponse = { type: 'ZLayerAirways', metadata, airways: [{ id: 'airway:V23', ident: 'V23',
  points: ['SUNOL', 'MID', 'EXIT'], segments: [
    { sequence: 1, from: 'SUNOL', to: 'MID', gap: false }, { sequence: 2, from: 'MID', to: 'EXIT', gap: false },
  ],
}] };
export const compositionPreferred: PreferredRoutesData = { type: 'ZLayerPreferredRoutes', metadata, routes: [{
  id: 'preferred-route:SFO:SJC:TEC:1', originId: 'SFO', destinationId: 'SJC', routeType: 'TEC', routeNumber: 1,
  designator: 'BAYT1', route: 'VECTORS SUNOL V23 EXIT', segments: [
    { sequence: 1, value: 'VECTORS', type: 'VECTOR' }, { sequence: 2, value: 'SUNOL', type: 'FIX' },
    { sequence: 3, value: 'V23', type: 'AIRWAY' }, { sequence: 4, value: 'EXIT', type: 'FIX' },
  ],
}] };
export const compositionTerminal: TerminalProceduresData = { type: 'ZLayerTerminalProcedures', metadata, procedures: [{
  id: 'terminal:DP:BAY1', ident: 'BAY1', kind: 'departure', name: 'BAY ONE', computerCode: 'BAY1.SUNOL', airports: ['SFO'],
  routes: ['START', 'EXIT'].map((first, i) => ({ name: first, kind: 'body', bodySequence: i + 1,
    airports: [{ ident: 'SFO', runway: i ? '01L' : '28R' }], points: [
      { sequence: 1, ident: first, type: 'FIX', next: 'MID' },
      { sequence: 2, ident: 'MID', type: 'FIX' }, // Explicit discontinuity to SUNOL.
      { sequence: 3, ident: 'SUNOL', type: 'FIX' },
    ],
  })),
}] };
