import { expect, test } from '@playwright/test';
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';

declare global {
  interface Window {
    weatherMapAudit: {
      map: MapLibreMap; errors: string[]; queries: () => number; stations: () => string[];
      loadAirports: () => void; setVisibility: (value: boolean) => void; setEnabled: (value: boolean) => void;
    };
  }
}

test('weather scope follows late tiles and camera changes while unrelated renders leave it idle', async ({ page }) => {
  const requests: string[][] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  // This fixture has no service worker; browser interception exercises the real map/client directly.
  await page.route('**/weather-map-test?*', route => {
    const ids = new URL(route.request().url()).searchParams.get('ids')!.split(',');
    requests.push(ids);
    return route.fulfill({ json: { type: 'FeatureCollection', features: ids.map(id => ({ type: 'Feature',
      geometry: { type: 'Point', coordinates: [id === 'KAAA' ? -122 : -112, 37] },
      properties: { id, obsTime: Date.now() / 1000, fltcat: id === 'KAAA' ? 'VFR' : 'IFR' },
    })) } });
  });
  await page.goto('/test/browser/weather-map.html');
  await page.waitForFunction(() => window.weatherMapAudit?.map.loaded());
  expect(requests).toEqual([]);
  await page.evaluate(() => window.weatherMapAudit.loadAirports());
  const stations = () => page.evaluate(() => window.weatherMapAudit.stations());
  await expect.poll(stations).toEqual(['KAAA']);
  await expect.poll(() => requests).toEqual([['KAAA']]);
  await page.waitForFunction(() => window.weatherMapAudit.map.loaded());
  const idleQueries = await page.evaluate(async () => {
    const audit = window.weatherMapAudit, start = audit.queries();
    for (let i = 0; i < 20; i++) { const rendered = audit.map.once('render'); audit.map.triggerRepaint(); await rendered; }
    return audit.queries() - start;
  });
  expect(idleQueries).toBe(0);
  await page.evaluate(() => window.weatherMapAudit.map.jumpTo({ center: [-112, 37] }));
  await expect.poll(stations).toEqual(['KBBB']);
  await expect.poll(() => requests).toEqual([['KAAA'], ['KBBB']]);
  const categories = () => page.evaluate(async () => {
    const data = await (window.weatherMapAudit.map.getSource('metar-airports') as GeoJSONSource).getData();
    return data.type === 'FeatureCollection' ? data.features.map(feature => feature.properties?.displayFlightCategory).sort() : [];
  });
  await expect.poll(categories).toEqual(['IFR', 'VFR']);
  await page.evaluate(() => window.weatherMapAudit.setEnabled(false));
  await expect.poll(categories).toEqual(['N/A', 'N/A']);
  await page.evaluate(() => window.weatherMapAudit.setVisibility(false));
  await expect.poll(stations).toEqual([]);
  await page.evaluate(() => { window.weatherMapAudit.setVisibility(true); window.weatherMapAudit.setEnabled(true); });
  await expect.poll(stations).toEqual(['KBBB']);
  await expect.poll(categories).toEqual(['IFR', 'VFR']);
  expect(await page.evaluate(() => window.weatherMapAudit.errors)).toEqual([]);
  expect(errors).toEqual([]);
});
