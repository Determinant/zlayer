import { test, expect, type Page } from '@playwright/test';

async function selectAirport(page: Page, id: string) {
  await page.getByLabel('Search FAA navigation data').fill(id);
  await page.locator('.search-results button').filter({ hasText: id }).click();
}

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
