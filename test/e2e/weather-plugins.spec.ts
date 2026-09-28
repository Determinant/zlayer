import { test, expect, type Page } from '@playwright/test';

test.beforeEach(async ({ request }) => { await request.post('/__test/reset'); });

async function settings(page: Page) {
  await page.getByLabel('Settings and offline downloads').click();
  await page.getByRole('tab', { name: 'Plugins', exact: true }).click();
}
const row = (page: Page, id: string) => page.locator(`.plugin-row[data-plugin="${id}"]`);

test('Map Display groups METAR and advisories under one AWC Weather heading with either plugin loaded', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false');
  for (const [metar, advisories] of [[true, true], [false, true], [true, false], [false, false], [true, true]]) {
    await settings(page);
    for (const [id, enabled] of [['metar', metar], ['weather-awc', advisories]] as const) {
      const toggle = row(page, id).getByRole('switch');
      if ((await toggle.getAttribute('aria-checked')) !== String(enabled)) await toggle.click();
    }
    await page.getByLabel('Close settings').click();
    await page.getByLabel('Open map layers', { exact: true }).click();
    const section = page.getByRole('region', { name: 'AWC Weather', exact: true });
    await expect(page.getByRole('heading', { name: 'AWC Weather', exact: true })).toHaveCount(metar || advisories ? 1 : 0);
    await expect(section.getByRole('switch', { name: /METAR flight categories/ })).toHaveCount(metar ? 1 : 0);
    await expect(section.getByRole('switch', { name: /Forecasts & advisories/ })).toHaveCount(advisories ? 1 : 0);
    if (metar && advisories) {
      await section.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath('awc-map-display.png'), animations: 'disabled' });
    }
    await page.getByLabel('Close map layers', { exact: true }).click();
  }
});

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

test('disabled weather removes airport reports and wind, stops requests, and keeps cached reports for re-enabling', async ({ page, context }, testInfo) => {
  const now = Date.parse('2026-09-17T18:00:00Z');
  await page.clock.install({ time: now });
  const requests = { metar: 0, taf: 0 };
  let magneticUnavailable = true;
  await context.route('**/nav/magnetic-model.json*', route => magneticUnavailable
    ? route.fulfill({ status: 404 }) : route.continue());
  await context.route('**/nav/airports.geojson*', async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.features.find((feature: { properties: { ident: string } }) => feature.properties.ident === 'KSBA')
      .properties.runways = [{ id: '07L/25R', lengthFt: 6052, widthFt: 150, surface: 'ASPH' }];
    await route.fulfill({ response, json: body });
  });
  await context.route('**/api/weather/metars.geojson?*', route => {
    requests.metar++;
    return route.fulfill({ json: { type: 'FeatureCollection', features: [{ type: 'Feature',
      geometry: { type: 'Point', coordinates: [-119.84, 34.43] },
      properties: { id: 'KSBA', obsTime: now / 1000, rawOb: 'METAR KSBA 171800Z 29520G30KT 10SM BKN012',
        wdir: 295, wspd: 20, wgst: 30, visib: 10 },
    }] } });
  });
  await context.route('**/api/weather/tafs.json?*', route => {
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
  await expect(runways.getByText('Magnetic reference unavailable')).toHaveCount(2);
  await expect(runways.getByText('Best Wind', { exact: true })).toHaveCount(0);
  await expect(runways).toContainText('≈250°M');
  await context.setOffline(true);
  magneticUnavailable = false;
  await context.setOffline(false);
  await expect(observation).toContainText('METAR KSBA');
  await expect(forecast).toContainText('TAF KSBA');
  await expect(observation).toHaveAttribute('aria-busy', 'false');
  await expect(forecast).toHaveAttribute('aria-busy', 'false');
  await expect(runways.getByRole('columnheader', { name: 'Wind (kt)' })).toBeVisible();
  const bestWind = runways.getByText('Best Wind', { exact: true });
  await expect(bestWind).toHaveCount(1);
  await expect(runways.getByRole('rowheader').filter({ hasText: 'Best Wind' })).toContainText('25R');
  await expect(bestWind).toHaveCSS('font-size', '11px');
  await expect(runways.getByRole('img', { name: 'Approximate Headwind: 17 kt, gust 25 kt', exact: true })).toBeVisible();
  await expect(runways.getByRole('img', { name: 'Approximate Crosswind from right: 11 kt, gust 16 kt', exact: true })).toHaveText('11G16');
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await bestWind.scrollIntoViewIfNeeded();
    await expect(bestWind).toBeVisible();
    await expect(runways.getByRole('columnheader')).toHaveText(['RWY', 'Pattern', 'Wind (kt)']);
    const layout = await runways.evaluate(element => {
      const marker = element.querySelector<HTMLElement>('.runway-best-wind')!;
      const winds = [...element.querySelectorAll('.runway-wind-components')];
      const rows = [...element.querySelectorAll<HTMLElement>('.runway-end')];
      const badge = marker.getBoundingClientRect();
      const badgeRow = marker.closest('tr')!.getBoundingClientRect();
      return {
        fits: element.scrollWidth <= element.clientWidth,
        inline: winds.every(wind => {
          const [along, cross] = [...wind.children].map(child => child.getBoundingClientRect());
          return Math.abs(along!.top - cross!.top) < 1 && along!.right < cross!.left
            && cross!.right <= wind.parentElement!.getBoundingClientRect().right;
        }),
        headingsInline: rows.every(row => {
          const id = row.querySelector('strong')!.getBoundingClientRect();
          const heading = row.querySelector('small')!.getBoundingClientRect();
          return id.right < heading.left && Math.abs((id.top + id.bottom - heading.top - heading.bottom) / 2) < 2;
        }),
        rowHeights: rows.map(row => row.getBoundingClientRect().height),
        iconsVisible: [...element.querySelectorAll('.runway-wind-component svg')].every(icon => {
          const box = icon.getBoundingClientRect();
          return box.width >= 14 && box.height >= 14;
        }),
        badgeCentered: Math.abs((badge.top + badge.bottom - badgeRow.top - badgeRow.bottom) / 2) < 1,
        badgeAfterHeading: badge.left > marker.closest('th')!.querySelector('small')!.getBoundingClientRect().right,
        badgeFits: badge.right <= marker.closest('th')!.getBoundingClientRect().right };
    });
    await runways.screenshot({ path: testInfo.outputPath(`best-wind-${width}.png`) });
    expect(layout.fits).toBe(true);
    expect(layout.inline).toBe(true);
    expect(layout.headingsInline).toBe(true);
    expect(Math.abs(layout.rowHeights[0]! - layout.rowHeights[1]!)).toBeLessThan(1);
    expect(layout.iconsVisible).toBe(true);
    expect(layout.badgeCentered).toBe(true);
    expect(layout.badgeAfterHeading).toBe(true);
    expect(layout.badgeFits).toBe(true);
  }
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
  await expect(runways).toContainText('07L/25R');
  await expect(runways).toContainText('6,052');
  await expect(runways.getByRole('columnheader', { name: 'Wind (kt)' })).toHaveCount(0);
  await expect(runways.locator('.runway-wind-notes')).toHaveCount(0);
  await expect(bestWind).toHaveCount(0);
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
  await expect(bestWind).toHaveCount(0);
  await page.clock.fastForward(6 * 60_000);
  expect(requests).toEqual(stopped);

  await settings(page);
  await row(page, 'metar').getByRole('switch').click();
  await page.getByLabel('Close settings').click();
  await expect(observation).toContainText('METAR KSBA');
  await expect(forecast).toContainText('TAF KSBA');
  await expect(runways.getByRole('columnheader', { name: 'Wind (kt)' })).toBeVisible();
  await expect.poll(() => requests.metar).toBeGreaterThan(stopped.metar);
  await expect(bestWind).toHaveCount(1);
  await expect.poll(() => requests.taf).toBeGreaterThan(stopped.taf);
});
