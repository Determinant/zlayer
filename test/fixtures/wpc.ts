/** Synthetic NOAA chart records in California, using the public AWC schema. */
export function surfaceCatalog() {
  return { prog: [
    { file: '20260922_18_F000_wpc.geojson', fhr: 0, vsecs: Date.parse('2026-09-22T18:00:00Z') / 1000 },
    ...[12, 18, 24, 36, 48, 72, 96, 120, 144, 168].map(fhr => ({
      file: `20260922_12_F${String(fhr).padStart(3, '0')}_wpc.geojson`, fhr, vsecs: Date.parse('2026-09-22T12:00:00Z') / 1000 + fhr * 3600,
    })),
  ] };
}
type ChartFeature = { type: string; geometry?: { type: string; coordinates: number[] | number[][] }; properties: Record<string, string | number> };
export function surfaceChart(file: string): { type: string; features: ChartFeature[] } {
  const hour = Number(file.slice(13, 16)), index = surfaceCatalog().prog.findIndex(c => c.file === file);
  const point = (coordinates: number[], properties: Record<string, string | number>) =>
    ({ type: 'Feature', geometry: { type: 'Point', coordinates }, properties });
  const line = (coordinates: number[][], properties: Record<string, string | number>) =>
    ({ type: 'Feature', geometry: { type: 'LineString', coordinates }, properties });
  const front = (fcode: number, front: string) => ({ type: 2, fcode, front, fpipdr: 1 });
  return { type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { type: 'fronts', datim: file.slice(0, 11), fhr: hour, filename: '/data/fixture.vgf' } },
    point([-122, 38], { type: 15, code: 'high' }), point([-122, 37.90], { type: 21, text: String(1024 + Math.max(0, index)) }),
    point([-121.5, 36.9], { type: 15, code: 'low' }), point([-121.5, 36.8], { type: 21, text: '1004' }),
    line([[-123, 39], [-122.8, 38.2], [-122.6, 37.5], [-122.5, 36.6]], front(420, 'Cold Front')),
    line([[-122, 38], [-121, 38.1], [-120, 38.4]], front(220, 'Warm Front')),
    line([[-124, 35.5], [-123, 35.5], [-122, 35.5]], front(20, 'Stationary')),
    line([[-123.5, 38.5], [-122.8, 38.8], [-122, 38.8]], front(620, 'Occluded')),
    line([[-122, 37], [-121.5, 36.5], [-121, 36]], front(840, 'Trough')),
    line([[-120.6, 36.3], [-120.4, 36.7], [-120.6, 37]], front(720, 'Dryline')),
    line([[-124, 38.8], [-123.7, 38.4]], front(920, 'Squall')),
    line([[-124.3, 36.2], [-123.4, 36.2], [-122.7, 36.2]], { type: 1 }),
    point([-123.7, 36.12], { type: 21, text: '1016' }),
    point([-123.9, 37.5], { type: 21, text: 'RIDGE$', txtcol: 6 }),
    point([-120.8, 37], { type: 15, code: 'hurricane' }),
    point([-120.7, 37.5], { type: 15, code: 'tropical storm' }),
  ] };
}
