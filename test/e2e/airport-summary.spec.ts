import { test, expect, type Page } from '@playwright/test';

async function selectAirport(page: Page, id: string) {
  await page.getByLabel('Search FAA navigation data').fill(id);
  await page.locator('.search-results button').filter({ hasText: id }).click();
}

for (const touch of [false, true]) test.describe(`airport map selection (${touch ? 'phone touch' : 'mouse'})`, () => {
  test.use(touch
    ? { hasTouch: true, deviceScaleFactor: 2, viewport: { width: 390, height: 844 } }
    : { hasTouch: false });

  for (const tier of ['major', 'regional', 'local', 'weather']) test(`${tier} airport info opens from its marker and label`, async ({ page, context }) => {
    await context.route('**/nav/airports.geojson*', async route => {
      const response = await route.fetch();
      const body = await response.json();
      const airport = body.features.find((feature: { properties: { ident: string } }) => feature.properties.ident === 'KSMO');
      Object.assign(airport.properties, {
        facilityType: 'A', use: tier === 'local' ? 'PR' : 'PU', towered: tier === 'major' || tier === 'weather',
        elevationFt: 170, longestRunwayFt: 3500, frequencies: [{ type: 'ATIS', frequencyMHz: 119.15 }],
      });
      await route.fulfill({ response, json: body });
    });
    await context.route('**/weather/metars.geojson?*', route => route.fulfill({ json: {
      type: 'FeatureCollection', features: tier === 'weather' ? [{
        type: 'Feature', geometry: { type: 'Point', coordinates: [-118.45, 34.02] },
        properties: { id: 'KSMO', obsTime: Date.now() / 1000, fltcat: 'VFR', rawOb: 'KSMO TEST METAR' },
      }] : [],
    } }));
    await page.addInitScript(() => {
      localStorage.setItem('zlayers-map-view-v1', JSON.stringify({ version: 1, center: [-118.45, 34.02], zoom: 12 }));
      // Keep the phone's label clear of the initially open terrain toolbox.
      localStorage.setItem('zlayer-ui:edge-tool', JSON.stringify({ version: 1, value: null }));
    });
    await page.goto('/');
    await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false');
    const canvas = page.locator('.maplibregl-canvas');
    const box = (await canvas.boundingBox())!;
    const facts = page.locator('.feature-facts');
    for (const label of [false, true]) {
      // At zoom 12 the label sits below the airport. Its center is outside
      // both the airport circle and the weather marker's hit area.
      const target = { x: box.x + box.width / 2, y: box.y + box.height / 2 + (label ? 26 : 0) };
      if (touch) await page.touchscreen.tap(target.x, target.y);
      else {
        await page.mouse.move(target.x, target.y);
        await expect(canvas).toHaveCSS('cursor', 'pointer');
        await page.mouse.click(target.x, target.y);
      }
      await expect(page.locator('.feature-card')).toContainText('KSMO TEST AIRPORT');
      await expect(facts).toContainText('170 ft');
      await expect(facts).toContainText('119.15 MHz');
      if (tier === 'weather') await expect(page.getByRole('region', { name: 'METAR', exact: true })).toContainText('KSMO TEST METAR');
      const close = page.getByRole('button', { name: 'Close detail', exact: true });
      if (touch) await close.tap();
      else await close.click();
      await expect(page.locator('.feature-card')).toBeHidden();
    }
  });
});

test('airport summary shows elevation, runway and local frequencies on desktop, phone, and offline reload', async ({ page, context }, testInfo) => {
  await context.route('**/nav/airports.geojson*', async route => {
    const response = await route.fetch();
    const body = await response.json();
    const airport = body.features.find((feature: { properties: { ident: string } }) => feature.properties.ident === 'KSMO');
    Object.assign(airport.properties, { elevationFt: 170, longestRunwayFt: 3500, frequencies: [
      { type: 'ATIS', frequencyMHz: 119.15, hours: '0700-2100' },
      { type: 'TOWER', frequencyMHz: 120.1, use: 'LCL/P', hours: '0700-2100' },
      { type: 'CTAF', frequencyMHz: 120.1, remarks: 'WHEN TOWER CLOSED' },
      { type: 'GROUND', frequencyMHz: 121.9, hours: '0700-2100' },
    ] });
    await route.fulfill({ response, json: body });
  });
  await context.route('**/weather/metars.geojson?*', route => route.fulfill({ json: { type: 'FeatureCollection', features: [] } }));
  await context.route('**/weather/tafs.json?*', route => route.fulfill({ status: 204 }));
  await page.goto('/');
  await selectAirport(page, 'KSMO');
  const facts = page.locator('.feature-facts');
  await expect(facts.locator('dt')).toHaveText(['Elevation', 'Longest runway', 'ATIS', 'Tower / CTAF', 'Ground']);
  await expect(facts.locator('dd')).toContainText(['170 ft', '3,500 ft', '119.15 MHz', '120.10 MHz', '121.90 MHz']);
  await expect(facts).not.toContainText('Type');
  // Search supplies the complete record. Re-select the actual map symbol to
  // verify nested details are restored after the compact map/tile projection.
  await expect.poll(() => page.evaluate(() => {
    const view = JSON.parse(localStorage.getItem('zlayers-map-view-v1') ?? '{}');
    return Math.abs((view.center?.[0] ?? 0) + 118.45) < 1e-8 && Math.abs((view.center?.[1] ?? 0) - 34.02) < 1e-8;
  })).toBe(true);
  await page.getByRole('button', { name: 'Close detail', exact: true }).click();
  const canvas = page.locator('.maplibregl-canvas');
  const box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await expect(facts.locator('dt')).toHaveText(['Elevation', 'Longest runway', 'ATIS', 'Tower / CTAF', 'Ground']);
  await expect(facts).toContainText('119.15 MHz');
  await page.screenshot({ path: testInfo.outputPath('airport-summary-desktop.png') });
  const notes = facts.getByRole('button', { name: 'Tower / CTAF: 120.10 MHz. Hours and notes' });
  await notes.focus();
  await notes.press('Enter');
  await expect(facts.getByText(/Tower hours 0700-2100/)).toBeVisible();
  await expect(facts.getByText(/WHEN TOWER CLOSED/)).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await facts.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('airport-summary-mobile.png') });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await context.setOffline(true);
  await page.reload();
  await expect(facts.locator('dt')).toHaveText(['Elevation', 'Longest runway', 'ATIS', 'Tower / CTAF', 'Ground']);
  await expect(facts).toContainText('119.15 MHz');
});

test('untowered weather/CTAF and older frequency-free exports do not invent services', async ({ page, context }) => {
  await context.route('**/nav/airports.geojson*', async route => {
    const response = await route.fetch();
    const body = await response.json();
    for (const airport of body.features) Object.assign(airport.properties, { elevationFt: 50, longestRunwayFt: 5000 });
    const airport = body.features.find((feature: { properties: { ident: string } }) => feature.properties.ident === 'KSMO');
    Object.assign(airport.properties, { towered: false, frequencies: [
      { type: 'AWOS', frequencyMHz: 127.275, use: 'SMO AWOS-3' },
      { type: 'CTAF', frequencyMHz: 122.8 },
    ] });
    await route.fulfill({ response, json: body });
  });
  await page.goto('/');
  await selectAirport(page, 'KSMO');
  const facts = page.locator('.feature-facts');
  await expect(facts.locator('dt')).toHaveText(['Elevation', 'Longest runway', 'AWOS', 'CTAF']);
  await expect(facts).toContainText('127.275 MHz');
  await selectAirport(page, 'KSBA');
  await expect(facts.locator('dt')).toHaveText(['Elevation', 'Longest runway']);
  await expect(facts).not.toContainText('MHz');
});
