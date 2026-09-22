import { expect, test, type Page } from '@playwright/test';
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import { selectCycle } from './settings';

async function restoreGpsPoint(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('zlayers-map-preferences-v1', JSON.stringify({ version: 2, chartBase: '',
      ownshipEnabled: false, visibility: { navaids: false } }));
    localStorage.setItem('zlayer-plugin:routes:draft', JSON.stringify({ version: 2,
      entries: [{ id: 'gps', text: '350000N1190535W' }] }));
    localStorage.setItem('zlayer-ui:selected-feature', JSON.stringify({ version: 1, value: {
      type: 'Feature', geometry: { type: 'Point', coordinates: [-119 - 5 / 60 - 35 / 3600, 35] },
      properties: { kind: 'coordinate', ident: '350000N1190535W', name: 'GPS waypoint' },
    } }));
    localStorage.setItem('zlayer-ui:selected-route-entry', JSON.stringify({ version: 1, value: 'gps' }));
  });
}

test('distinct ID-less stations with the same name keep their rows when reordered', async ({ page }) => {
  await page.goto('/test/browser/identification.html?duplicate-names');
  await page.getByRole('button', { name: /Identify .* with nearby navaids/ }).click();
  const rows = page.locator('.nearby-navaids tbody tr');
  await expect(rows).toHaveCount(6);
  expect(await rows.locator('th strong').allTextContents()).toEqual(Array(6).fill('DUP'));
  const original = await rows.evaluateAll(elements => elements.map(element => {
    const frequency = element.querySelector('th small')!.textContent!;
    (element as HTMLElement).dataset.originalFrequency = frequency;
    return frequency;
  }));
  await page.getByRole('button', { name: 'Reverse stations', exact: true }).click();
  await expect(rows.locator('th small')).toHaveText([...original].reverse());
  expect(await rows.evaluateAll(elements => elements.every(element =>
    (element as HTMLElement).dataset.originalFrequency === element.querySelector('th small')!.textContent))).toBe(true);
});

for (const [width, height] of [[1280, 900], [320, 568]] as const) {
  test(`ID shows radial and distance with navaids hidden and after an offline reload at ${width}px`, async ({ page, context }, testInfo) => {
    await page.setViewportSize({ width, height });
    await restoreGpsPoint(page);
    await page.goto('/');
    const identify = page.getByRole('button', { name: /Identify .* with nearby navaids/ });
    await expect(identify).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.nearby-navaids')).toHaveCount(0);
    await identify.click();
    const references = page.getByRole('region', { name: 'Nearby VOR/DME', exact: true });
    await expect(references.getByRole('row', { name: /CMA/ })).toHaveText('CMAMON115.8 · VOR/DMEMB 345°TB 360°47.3');
    await references.scrollIntoViewIfNeeded();
    await expect(references).toBeVisible();
    expect(await references.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('gps-nearby-vor.png') });
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await context.setOffline(true);
    await page.reload();
    await expect(identify).toHaveAttribute('aria-pressed', 'true');
    await expect(references).toContainText('MB 345°');
    await expect(references).toContainText('47.3');
  });
}

test('a failed navaid export does not report an empty nearby area', async ({ page, context }) => {
  await restoreGpsPoint(page);
  await context.route('**/nav/navaids.geojson*', route => route.fulfill({ status: 503, body: 'Unavailable' }));
  await page.goto('/');
  await page.getByRole('button', { name: /Identify .* with nearby navaids/ }).click();
  await expect(page.getByRole('region', { name: 'Nearby VOR/DME', exact: true })).toContainText('Navaid data unavailable.');
});

test('an older cached export keeps TB visible while magnetic alignment is missing', async ({ page, context }) => {
  await restoreGpsPoint(page);
  await context.route('**/nav/navaids.geojson*', async route => {
    const response = await route.fetch();
    const data = await response.json();
    for (const feature of data.features) delete feature.properties.stationDeclinationDeg;
    await route.fulfill({ response, json: data });
  });
  await page.goto('/');
  const identify = page.getByRole('button', { name: /Identify .* with nearby navaids/ });
  await identify.click();
  const references = page.getByRole('region', { name: 'Nearby VOR/DME', exact: true });
  await expect(references.getByRole('row', { name: /CMA/ })).toHaveText('CMAMON115.8 · VOR/DMEMB —TB 360°47.3');
  await expect(references).toContainText('magnetic bearing unavailable');
  await expect(references).toContainText('TB 360°');
  await expect(references).not.toContainText('MB 360°');
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await context.setOffline(true);
  await page.reload();
  await expect(identify).toHaveAttribute('aria-pressed', 'true');
  await expect(references.getByRole('row', { name: /CMA/ })).toHaveText('CMAMON115.8 · VOR/DMEMB —TB 360°47.3');
  await expect(references).toContainText('TB 360°');
  await expect(references).not.toContainText('MB 360°');
});

test('a restored GPS point adopts a rebuilt navigation export after catalog revalidation', async ({ page, context }) => {
  await restoreGpsPoint(page);
  await context.route('**/nav/manifest.json', async route => {
    const response = await route.fetch();
    const data = await response.json();
    data.generatedAt = '2026-09-02T00:00:00Z';
    await route.fulfill({ response, json: data });
  });
  await context.route('**/nav/navaids.geojson*', async route => {
    const response = await route.fetch();
    const data = await response.json();
    for (const feature of data.features) delete feature.properties.stationDeclinationDeg;
    await route.fulfill({ response, json: data });
  });
  await page.goto('/');
  const identify = page.getByRole('button', { name: /Identify .* with nearby navaids/ });
  await identify.click();
  const references = page.getByRole('region', { name: 'Nearby VOR/DME', exact: true });
  await expect(references).toContainText('MB —');
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await context.unroute('**/nav/manifest.json');
  await context.unroute('**/nav/navaids.geojson*');
  await page.reload();
  await expect(identify).toHaveAttribute('aria-pressed', 'true');
  await expect(references).toContainText('MB 345°');
  await expect(references).toContainText('TB 360°');
  await context.setOffline(true);
  await page.reload();
  await expect(identify).toHaveAttribute('aria-pressed', 'true');
  await expect(references).toContainText('MB 345°');
});


for (const entity of ['GPS point', 'airport'] as const) {
  test(`ID fills missing MB for the ${entity} in an older saved region and retains it after offline reload`, async ({ page, context, request }) => {
    await request.post('/__test/id-navaids-legacy');
    try {
      if (entity === 'GPS point') await restoreGpsPoint(page);
      await page.goto('/');
      await selectCycle(page, '2026-09-03');
      await page.getByLabel('Settings and offline downloads').click();
      await page.getByLabel('Find a state or territory').fill('California');
      await page.locator('.region-row').getByRole('button', { name: 'Download', exact: true }).click();
      await expect(page.locator('.download-card .offline-tag')).toHaveText('Saved');
      await page.getByLabel('Close settings').click();
      if (entity === 'airport') {
        await page.getByLabel('Search FAA navigation data').fill('KSBA');
        await page.locator('.search-results button').filter({ hasText: 'KSBA' }).click();
      }
      const savedBytes = () => page.evaluate(async () => {
        const cache = await caches.open('zlayers-data-v6');
        const keys = (await cache.keys()).filter(key => key.url.includes('/nav/navaids.geojson') && key.url.includes('jsonSha256='));
        return Promise.all(keys.map(async key => ({ url: key.url, body: await (await cache.match(key))!.text() })));
      });
      const pinned = await savedBytes();
      expect(pinned).toHaveLength(1);
      expect(pinned[0]!.body).not.toContain('stationDeclinationDeg');
      const identify = page.getByRole('button', { name: /Identify .* with nearby navaids/ });
      const references = page.getByRole('region', { name: 'Nearby VOR/DME', exact: true });
      const row = references.getByRole('row', { name: entity === 'GPS point' ? /GMN/ : /CMA/ });
      await identify.click();
      await expect(row.locator('.navaid-magnetic')).toHaveText('MB —');
      const trueBearing = entity === 'GPS point' ? 'TB 316°' : 'TB 290°';
      await expect(row.locator('.navaid-true')).toHaveText(trueBearing);
      await identify.click();
      await request.post('/__test/id-navaids-current');
      // Keep the app and selected catalog open: ID itself must discover the rebuild.
      await identify.click();
      const magneticBearing = entity === 'GPS point' ? 'MB 300°' : 'MB 275°';
      await expect(row.locator('.navaid-magnetic')).toHaveText(magneticBearing);
      await expect(row.locator('.navaid-true')).toHaveText(trueBearing);
      expect(await savedBytes()).toEqual(pinned);
      await page.waitForFunction(() => !!navigator.serviceWorker.controller);
      await context.setOffline(true);
      await page.reload();
      await expect(identify).toHaveAttribute('aria-pressed', 'true');
      await expect(row.locator('.navaid-magnetic')).toHaveText(magneticBearing);
      await expect(row.locator('.navaid-true')).toHaveText(trueBearing);
      expect(await savedBytes()).toEqual(pinned);
    } finally { await request.post('/__test/reset'); }
  });
}

test('ID works for airports without a route and resets when tabs or selection change', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('zlayers-map-preferences-v1', JSON.stringify({ version: 2, chartBase: '',
      ownshipEnabled: false, visibility: { navaids: false } }));
  });
  await page.goto('/');
  const search = page.getByLabel('Search FAA navigation data');
  await search.fill('KSBA');
  await page.locator('.search-results button').filter({ hasText: 'KSBA' }).click();
  const identify = page.getByRole('button', { name: 'Identify KSBA with nearby navaids' });
  await identify.click();
  await expect(page.locator('.nearby-navaids')).toContainText('CMA');
  await page.getByRole('tab', { name: 'Info', exact: true }).click();
  await expect(identify).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.nearby-navaids')).toHaveCount(0);
  await identify.click();
  await page.getByRole('tab', { name: 'Plates', exact: true }).click();
  await expect(page.locator('.nearby-navaids')).toHaveCount(0);
  await identify.click();
  await search.fill('CMA');
  await page.locator('.search-results button').filter({ hasText: 'CMA' }).click();
  const navaidId = page.getByRole('button', { name: 'Identify CMA with nearby navaids' });
  await expect(navaidId).toHaveAttribute('aria-pressed', 'false');
  await navaidId.click();
  await expect(page.locator('.nearby-navaids')).toContainText('No VOR stations within 100 NM.');
  await page.getByRole('button', { name: 'Close detail' }).click();
  await expect(page.locator('.nearby-navaids')).toHaveCount(0);
});

for (const [scenario, query, count] of [['present', '', 6], ['missing', '?missing-alignment', 6],
  ['present on short, clustered lines', '?clustered', 3]] as const) test(`the top three stations render MB and distance with magnetic alignment ${scenario}`, async ({ page }, testInfo) => {
  await page.goto(`/test/browser/identification.html${query}`);
  const identify = page.getByRole('button', { name: /Identify .* with nearby navaids/ });
  await identify.click();
  await expect(page.locator('.nearby-navaids tbody tr')).toHaveCount(count);
  const mapped = await page.locator('.nearby-navaids .is-mapped th strong').allTextContents();
  expect(mapped).toHaveLength(3);
  expect(mapped).not.toContain('TEST'); // A nearer non-MON station follows useful MON candidates.
  const references = await page.locator('.nearby-navaids .is-mapped').evaluateAll(rows => rows.map(row => {
    const cells = row.querySelectorAll('td');
    return `${cells[0]!.querySelector('.navaid-magnetic')!.textContent?.replace('—', '-')} · ${cells[1]!.textContent} NM`;
  }));
  await expect(page.locator('.nearby-navaids .navaid-true')).toHaveCount(count);
  await page.waitForFunction(({ mapped, references }) => {
    const map = (window as unknown as { identificationAudit?: { map: MapLibreMap } }).identificationAudit?.map;
    if (!map?.getLayer('navaid-id-references')) return false;
    const labels = new Set(map.queryRenderedFeatures({ layers: ['navaid-id-labels'] }).map(feature => feature.properties.ident));
    const lineLabels = new Set(map.queryRenderedFeatures({ layers: ['navaid-id-references'] })
      .map(feature => feature.properties.reference));
    return mapped.every(ident => labels.has(ident)) && references.every(reference => lineLabels.has(reference));
  }, { mapped, references }, { timeout: 10_000 });
  const readMap = () => page.evaluate(async () => {
    const map = (window as unknown as { identificationAudit: { map: MapLibreMap } }).identificationAudit.map;
    const source = map.getSource('navaid-identification') as GeoJSONSource;
    const data = await source.getData();
    return { data, hasTrueBearingLayer: Boolean(map.getLayer('navaid-id-true-bearings')),
      width: map.getPaintProperty('navaid-id-lines', 'line-width'),
      dash: map.getPaintProperty('navaid-id-lines', 'line-dasharray'),
      color: map.getPaintProperty('navaid-id-lines', 'line-color') };
  });
  const visible = await readMap();
  expect(visible.data.type).toBe('FeatureCollection');
  if (visible.data.type !== 'FeatureCollection') throw new Error('Expected a collection');
  expect(visible.data.features.filter(feature => feature.geometry.type === 'LineString')).toHaveLength(3);
  expect(visible.hasTrueBearingLayer).toBe(false);
  expect(visible.dash).toEqual([4, 2]);
  expect(visible.width).toBe(2);
  expect(visible.color).toBe('#005a9c');
  await page.screenshot({ path: testInfo.outputPath('identification-connections.png') });
  if (query === '?clustered') {
    await page.evaluate(() => {
      const map = (window as unknown as { identificationAudit: { map: MapLibreMap } }).identificationAudit.map;
      map.jumpTo({ zoom: 6.2, bearing: 135, pitch: 45 });
    });
    await expect.poll(() => page.evaluate(() => {
      const map = (window as unknown as { identificationAudit: { map: MapLibreMap } }).identificationAudit.map;
      const references = map.queryRenderedFeatures({ layers: ['navaid-id-references'] });
      return references.length === 3 && references.every(feature =>
        Math.abs(Number(feature.properties.rotation)) <= 90);
    })).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('short-rotated-connections.png') });
  }
  await identify.click();
  await expect.poll(async () => (await readMap()).data).toEqual({ type: 'FeatureCollection', features: [] });
  await identify.click();
  await expect(page.locator('.nearby-navaids')).toBeVisible();
  await page.getByRole('button', { name: 'Close detail' }).click();
  await expect.poll(async () => (await readMap()).data).toEqual({ type: 'FeatureCollection', features: [] });
  await expect(page.getByRole('alert')).toBeEmpty();
});

test('ID labels follow the visible world copy when the map is wrapped, rotated and tilted', async ({ page }) => {
  await page.goto('/test/browser/identification.html?clustered');
  await page.getByRole('button', { name: /Identify .* with nearby navaids/ }).click();
  await page.waitForFunction(() => (window as unknown as { identificationAudit: { map: MapLibreMap } })
    .identificationAudit.map.getLayer('navaid-id-references'));
  for (const longitude of [241.3, -478.7]) {
    await page.evaluate(longitude => {
      (window as unknown as { identificationAudit: { map: MapLibreMap } }).identificationAudit.map
        .jumpTo({ center: [longitude, 35], zoom: 7, bearing: 40, pitch: 45 });
    }, longitude);
    await expect.poll(() => page.evaluate(async () => {
      const map = (window as unknown as { identificationAudit: { map: MapLibreMap } }).identificationAudit.map;
      const data = await (map.getSource('navaid-identification') as GeoJSONSource).getData();
      if (data.type !== 'FeatureCollection') return false;
      const labels = map.queryRenderedFeatures({ layers: ['navaid-id-references'] });
      if (labels.length !== 3) return false;
      const visible = ([lng, lat]: number[]) => map.project([
        lng! + 360 * Math.round((map.getCenter().lng - lng!) / 360), lat!,
      ]);
      return data.features.filter(feature => feature.geometry.type === 'LineString').every(line => {
        if (line.geometry.type !== 'LineString') return false;
        const label = data.features.find(feature => feature.geometry.type === 'Point' &&
          feature.properties?.reference === line.properties?.reference);
        if (label?.geometry.type !== 'Point') return false;
        const a = visible(line.geometry.coordinates[0]!), b = visible(line.geometry.coordinates[1]!);
        const position = visible(label.geometry.coordinates);
        const angle = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
        const upright = angle > 90 ? angle - 180 : angle < -90 ? angle + 180 : angle;
        return Math.hypot(position.x - (a.x + b.x) / 2, position.y - (a.y + b.y) / 2) < 1 &&
          Math.abs(Number(label.properties?.rotation) - upright) < 0.1;
      });
    })).toBe(true);
  }
  await expect(page.getByRole('alert')).toBeEmpty();
});
