import { expect, test } from '@playwright/test';
import type {} from '../browser/selection-order';

for (const touch of [false, true]) test.describe(`selected symbol order (${touch ? 'touch' : 'mouse'})`, () => {
  test.use({ hasTouch: touch, deviceScaleFactor: touch ? 2 : 1, permissions: ['geolocation'],
    geolocation: { longitude: -122, latitude: 37, accuracy: 5 } });

  test('chosen entities draw and receive clicks above overlapping airports, below ownship', async ({ page }, testInfo) => {
    await page.goto('/test/browser/selection-order.html');
    await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
    const firstHit = () => page.evaluate(() => window.selectionOrder.hits()[0]);
    const pixel = () => page.evaluate(() => window.selectionOrder.pixel());
    const clickCenter = async () => {
      const point = await page.evaluate(() => {
        const p = window.selectionOrder.map.project([-122, 37]); return { x: p.x, y: p.y };
      });
      if (touch) await page.touchscreen.tap(point.x, point.y);
      else await page.mouse.click(point.x, point.y);
    };
    await expect.poll(firstHit).toMatchObject({ id: 'airport:KSFO', layer: 'airports-weather-points' });
    await expect.poll(pixel).toEqual([32, 198, 107]);

    for (const [ident, id] of [['CMA', 'navaid:CMA'], ['FIXIT', 'fix:FIXIT'], ['VPONE', 'vfr:VPONE'], ['KSFO', 'airport:KSFO']]) {
      await page.evaluate(ident => window.selectionOrder.select(ident), ident);
      await expect.poll(firstHit).toMatchObject({ id, layer: expect.stringContaining('zlayer-focus-') });
      await expect(page.locator('.selection-marker-label')).toHaveText(ident!);
      if (ident === 'CMA') {
        // VOR/DME's pale center replaces the green circle in the actual canvas.
        await expect.poll(async () => (await pixel()).every(value => value > 140)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath('selected-navaid-over-airport.png') });
      }
      if (ident === 'KSFO') await expect.poll(pixel).toEqual([32, 198, 107]);
      await clickCenter();
      await expect.poll(() => page.evaluate(() => window.selectionOrder.selected().id)).toBe(id);
    }
    await page.evaluate(() => window.selectionOrder.select('CMA'));
    for (const enabled of [false, true]) {
      await page.evaluate(enabled => window.selectionOrder.weather(enabled), enabled);
      await expect.poll(firstHit).toMatchObject({ id: 'navaid:CMA', layer: 'zlayer-focus-navaids-icons' });
    }
    await page.evaluate(() => window.selectionOrder.map.jumpTo({ bearing: 70, zoom: 13 }));
    await expect.poll(firstHit).toMatchObject({ id: 'navaid:CMA', layer: 'zlayer-focus-navaids-icons' });
    await page.evaluate(() => window.selectionOrder.select());
    await expect(page.locator('.selection-marker')).toHaveCount(0);
    await expect.poll(firstHit).toMatchObject({ id: 'airport:KSFO', layer: 'airports-weather-points' });

    // Shared sources preserve route occurrence identity through the foreground hit.
    await page.evaluate(() => { window.selectionOrder.route(true); window.selectionOrder.select('CMA'); });
    await expect.poll(firstHit).toMatchObject({ source: 'route-plan', layer: 'zlayer-focus-route-waypoints', pointId: expect.any(String) });
    const pointId = (await firstHit())!.pointId;
    await clickCenter();
    await expect.poll(() => page.evaluate(() => window.selectionOrder.selected())).toEqual({ id: 'navaid:CMA', pointId });
    await page.evaluate(() => { window.selectionOrder.route(false); window.selectionOrder.select('370000N1220000W'); });
    await expect.poll(firstHit).toMatchObject({ source: 'waypoint-inspection', layer: 'zlayer-focus-waypoint-inspection-point' });

    await page.evaluate(() => { window.selectionOrder.select('CMA'); window.selectionOrder.ownship(true); });
    await expect.poll(pixel).toEqual([50, 181, 255]);
    await page.evaluate(() => window.selectionOrder.weather(false));
    await page.evaluate(() => window.selectionOrder.weather(true));
    await expect.poll(pixel).toEqual([50, 181, 255]);
    expect(await page.evaluate(() => window.selectionOrder.errors)).toEqual([]);
  });
});

test('area fills and reference lines stay below entity colors across late attachment', async ({ page }) => {
  await page.goto('/test/browser/selection-order.html');
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await expect.poll(() => page.evaluate(() => window.selectionOrder.pixel())).toEqual([32, 198, 107]);
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.evaluate(() => window.selectionOrder.annotations(true));
    await expect.poll(() => page.evaluate(() => {
      const map = window.selectionOrder.map;
      return ['notam-tfr-fill', 'ruler-line', 'navaid-id-lines'].every(id => map.queryRenderedFeatures({ layers: [id] }).length > 0);
    })).toBe(true);
    await expect.poll(() => page.evaluate(() => window.selectionOrder.pixel())).toEqual([32, 198, 107]);
    const order = await page.evaluate(() => window.selectionOrder.map.getStyle().layers!.map(layer => layer.id));
    expect(order.indexOf('notam-tfr-line')).toBeLessThan(order.indexOf('route-line-halo'));
    for (const id of ['route-line', 'ruler-line', 'navaid-id-lines']) {
      expect(order.indexOf(id)).toBeLessThan(order.indexOf('airports-major-points'));
    }
    await page.evaluate(() => window.selectionOrder.annotations(false));
  }
  expect(await page.evaluate(() => window.selectionOrder.errors)).toEqual([]);
});

test('selected labels leave no invisible targets at their old positions', async ({ page }) => {
  await page.goto('/test/browser/selection-order.html');
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await expect.poll(() => page.evaluate(() => {
    const map = window.selectionOrder.map;
    return map.queryRenderedFeatures({ layers: ['airports-weather-labels'] }).length;
  })).toBeGreaterThan(0);
  const labelPoint = await page.evaluate(() => {
    const map = window.selectionOrder.map, center = map.project([-122, 37]);
    for (let dy = 20; dy < 45; dy++) {
      const point: [number, number] = [center.x, center.y + dy];
      if (map.queryRenderedFeatures(point, { layers: ['airports-weather-labels'] }).length) return point;
    }
    throw new Error('Airport label has no hit target outside its symbol');
  });
  await page.evaluate(() => window.selectionOrder.select('KSFO'));
  await expect(page.locator('.selection-marker-label')).toHaveText('KSFO');
  await expect.poll(() => page.evaluate(point => window.selectionOrder.map.queryRenderedFeatures(point,
    { layers: ['airports-weather-labels', 'airports-major-labels'] }).length, labelPoint)).toBe(0);
  await page.evaluate(() => window.selectionOrder.select());
  await expect.poll(() => page.evaluate(point => window.selectionOrder.map.queryRenderedFeatures(point,
    { layers: ['airports-weather-labels'] }).length, labelPoint)).toBeGreaterThan(0);
  await page.evaluate(() => window.selectionOrder.route(true));
  await expect.poll(() => page.evaluate(() => window.selectionOrder.map.queryRenderedFeatures({ layers: ['route-waypoint-labels'] }).length)).toBeGreaterThan(0);
  await page.evaluate(() => window.selectionOrder.select('CMA'));
  await expect.poll(() => page.evaluate(() => window.selectionOrder.map.queryRenderedFeatures({ layers: ['route-waypoint-labels'] }).length)).toBe(0);
  await page.evaluate(() => window.selectionOrder.select());
  await expect.poll(() => page.evaluate(() => window.selectionOrder.map.queryRenderedFeatures({ layers: ['route-waypoint-labels'] }).length)).toBeGreaterThan(0);
});
