import { test, expect, type Page } from '@playwright/test';

test.beforeEach(async ({ request }) => { await request.post('/__test/reset'); });

async function settings(page: Page) {
  await page.getByLabel('Settings and offline downloads').click();
  await page.getByRole('tab', { name: 'Plugins', exact: true }).click();
}
const row = (page: Page, id: string) => page.locator(`.plugin-row[data-plugin="${id}"]`);

test('navigation and weather enable independently and preserve their choices across refresh', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await settings(page);
  await row(page, 'navigation').getByRole('switch').click();
  await expect(row(page, 'navigation').getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  await expect(row(page, 'metar').getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  await page.reload();
  await expect(row(page, 'navigation').getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  await expect(row(page, 'metar').getByRole('switch')).toHaveAttribute('aria-checked', 'true');

  await row(page, 'metar').getByRole('switch').click();
  await expect(row(page, 'metar').getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  await row(page, 'metar').getByRole('switch').click();
  await expect(row(page, 'metar').getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  await expect(row(page, 'navigation').getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  await row(page, 'metar').getByRole('switch').click();
  await row(page, 'navigation').getByRole('switch').click();
  await expect(row(page, 'navigation').getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  await expect(row(page, 'metar').getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  await page.getByLabel('Close settings').click();
  await expect(page.getByLabel('Search FAA navigation data')).toBeVisible();
  await expect(page.locator('.map-runtime-error')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('disabled weather removes airport reports and wind, stops requests, and keeps cached reports for re-enabling', async ({ page, context }) => {
  const now = Date.parse('2026-09-17T18:00:00Z');
  await page.clock.install({ time: now });
  const requests = { metar: 0, taf: 0 };
  await context.route('**/nav/airports.geojson*', async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.features.find((feature: { properties: { ident: string } }) => feature.properties.ident === 'KSBA')
      .properties.runways = [{ id: '07/25', lengthFt: 6052, widthFt: 150, surface: 'ASPH',
        ends: [{ id: '07', trueHeadingDeg: 70 }, { id: '25', trueHeadingDeg: 250 }] }];
    await route.fulfill({ response, json: body });
  });
  await context.route('**/weather/metars.geojson?*', route => {
    requests.metar++;
    return route.fulfill({ json: { type: 'FeatureCollection', features: [{ type: 'Feature',
      geometry: { type: 'Point', coordinates: [-119.84, 34.43] },
      properties: { id: 'KSBA', obsTime: now / 1000, rawOb: 'METAR KSBA 171800Z 28010KT 10SM BKN012',
        wdir: 280, wspd: 10, visib: 10 },
    }] } });
  });
  await context.route('**/weather/tafs.json?*', route => {
    requests.taf++;
    return route.fulfill({ json: [{ icaoId: 'KSBA', lon: -119.84, lat: 34.43,
      issueTime: new Date(now).toISOString(), validTimeFrom: now / 1000, validTimeTo: now / 1000 + 86400,
      rawTAF: 'TAF KSBA 171800Z 1718/1818 28010KT P6SM SCT030', fcsts: [],
    }] });
  });
  await page.goto('/');
  await page.getByLabel('Search FAA navigation data').fill('KSBA');
  await page.locator('.search-results button').filter({ hasText: 'KSBA' }).click();
  const observation = page.getByRole('region', { name: 'METAR', exact: true });
  const forecast = page.getByRole('region', { name: 'TAF', exact: true });
  const runways = page.getByRole('region', { name: 'Runways', exact: true });
  await expect(observation).toContainText('METAR KSBA');
  await expect(forecast).toContainText('TAF KSBA');
  await expect(observation).toHaveAttribute('aria-busy', 'false');
  await expect(forecast).toHaveAttribute('aria-busy', 'false');
  await expect(runways.getByRole('columnheader', { name: 'Wind (kt)' })).toBeVisible();
  const cached = await page.evaluate(() => [
    localStorage.getItem('zlayer-plugin:metar:metars'), localStorage.getItem('zlayer-plugin:metar:tafs'),
  ]);
  expect(cached.every(Boolean)).toBe(true);

  await settings(page);
  await row(page, 'metar').getByRole('switch').click();
  await expect(row(page, 'navigation').getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  await expect(observation).toHaveCount(0);
  await expect(forecast).toHaveCount(0);
  await page.getByLabel('Close settings').click();
  await expect(runways).toBeVisible();
  await expect(runways).toContainText('07/25');
  await expect(runways).toContainText('6,052');
  await expect(runways.getByRole('columnheader', { name: 'Wind (kt)' })).toHaveCount(0);
  await expect(runways.locator('.runway-wind-notes')).toHaveCount(0);
  const stopped = { ...requests };
  await page.clock.fastForward(6 * 60_000);
  expect(requests).toEqual(stopped);
  expect(await page.evaluate(() => [
    localStorage.getItem('zlayer-plugin:metar:metars'), localStorage.getItem('zlayer-plugin:metar:tafs'),
  ])).toEqual(cached);

  await page.reload();
  await expect(runways).toBeVisible();
  await expect(observation).toHaveCount(0);
  await expect(forecast).toHaveCount(0);
  await expect(runways.getByRole('columnheader', { name: 'Wind (kt)' })).toHaveCount(0);
  await page.clock.fastForward(6 * 60_000);
  expect(requests).toEqual(stopped);

  await settings(page);
  await row(page, 'metar').getByRole('switch').click();
  await page.getByLabel('Close settings').click();
  await expect(observation).toContainText('METAR KSBA');
  await expect(forecast).toContainText('TAF KSBA');
  await expect(runways.getByRole('columnheader', { name: 'Wind (kt)' })).toBeVisible();
  await expect.poll(() => requests.metar).toBeGreaterThan(stopped.metar);
  await expect.poll(() => requests.taf).toBeGreaterThan(stopped.taf);
});
