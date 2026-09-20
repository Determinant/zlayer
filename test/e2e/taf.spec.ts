import { test, expect, type Page } from '@playwright/test';

test.use({ locale: 'en-US', timezoneId: 'America/Los_Angeles' });

const now = Date.parse('2026-09-17T18:00:00Z');
const from = now / 1000;
const rawTAF = 'TAF KSBA 171720Z 1718/1818 28010KT P6SM SCT030 FM171900 28010KT P6SM BKN020 TEMPO 1720/1721 2SM BR BKN008 FM172100 28004KT 1/2SM FG VV002';
const report = { icaoId: 'KSBA', issueTime: '2026-09-17T17:20:00Z', validTimeFrom: from, validTimeTo: from + 86400, rawTAF,
  fcsts: [
    { timeFrom: from, timeTo: from + 3600, visib: '6+', clouds: [{ cover: 'SCT', base: 3000 }] },
    { timeFrom: from + 3600, timeTo: from + 10800, fcstChange: 'FM', visib: '6+', clouds: [{ cover: 'BKN', base: 2000 }] },
    { timeFrom: from + 7200, timeTo: from + 10800, fcstChange: 'TEMPO', visib: 2, clouds: [{ cover: 'BKN', base: 800 }] },
    { timeFrom: from + 10800, timeTo: from + 86400, fcstChange: 'FM', visib: 0.5, vertVis: 200, clouds: [] },
  ] };
async function selectAirport(page: Page, id: string) {
  await page.getByLabel('Search FAA navigation data').fill(id);
  await page.locator('.search-results button').filter({ hasText: id }).click();
}

test('TAF periods follow METAR with category colors, wrap on phones, and survive an offline reload', async ({ page, context }, testInfo) => {
  await page.clock.install({ time: now });
  const errors: string[] = [];
  const requests: string[] = [];
  let offline = false;
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/weather/tafs.json?*', route => {
    // Mock responses bypass offline emulation, including after a reload.
    if (offline) return route.abort('internetdisconnected');
    const id = new URL(route.request().url()).searchParams.get('ids')!;
    requests.push(id ?? 'nearby');
    return route.fulfill({ status: id === 'KSBA' ? 200 : 204, contentType: 'application/json', body: id === 'KSBA' ? JSON.stringify([report]) : '' });
  });
  await page.goto('/');
  await selectAirport(page, 'KSBA');
  const taf = page.getByRole('region', { name: 'TAF', exact: true });
  await expect(taf.locator('.taf-category')).toHaveText(['VFR', 'MVFR', 'IFR', 'LIFR']);
  expect(await taf.locator('code').evaluateAll(elements => elements.map(element => element.textContent).join(' '))).toBe(rawTAF);
  await expect(taf.locator('.taf-local-time')).toHaveText(['Sep 17 · 11:00 PDT – Sep 18 · 11:00 PDT', 'Sep 17 · 12:00 PDT', 'Sep 17 · 14:00 PDT']);
  expect(await taf.locator('.taf-local-time').evaluateAll(elements => elements.map(element => getComputedStyle(element).color)))
    .toEqual(['rgb(143, 167, 185)', 'rgb(143, 167, 185)', 'rgb(143, 167, 185)']);
  await expect(taf.locator('code').nth(1)).toHaveText('FM171900 28010KT P6SM BKN020');
  expect(await taf.locator('code').evaluateAll(elements => elements.map(element => getComputedStyle(element).color)))
    .toEqual(['rgb(32, 198, 107)', 'rgb(98, 169, 255)', 'rgb(255, 112, 112)', 'rgb(233, 123, 245)']);
  await taf.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('taf-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await taf.scrollIntoViewIfNeeded();
  expect(await taf.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('taf-mobile.png') });
  await selectAirport(page, 'KSMO');
  await expect(taf).toContainText('No nearby TAF within 50 NM.');
  await expect(taf.locator('code')).toHaveCount(0);
  await selectAirport(page, 'KSBA');
  await expect(taf.locator('code')).toHaveCount(4);
  expect(requests).toEqual(['KSBA', 'KSMO', 'nearby']);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  offline = true;
  await context.setOffline(true);
  await expect(taf).toContainText('Cached forecast');
  await expect(taf).toContainText('Offline');
  await page.reload();
  await selectAirport(page, 'KSBA');
  await expect(taf).toContainText('Cached forecast');
  await expect(taf.locator('code')).toHaveCount(4);
  expect(errors).toEqual([]);
});

test('a production service worker cannot hide failed TAF refreshes, and reconnecting recovers', async ({ page, context }) => {
  await page.clock.install({ time: now });
  let failed = false;
  await context.route('**/weather/tafs.json?*', route => route.fulfill({ status: failed ? 503 : 200,
    contentType: 'application/json', body: failed ? '' : JSON.stringify([report]) }));
  await page.goto('/');
  await selectAirport(page, 'KSBA');
  const taf = page.getByRole('region', { name: 'TAF', exact: true });
  await expect(taf).toContainText('Updated');
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  failed = true;
  await page.clock.runFor(5 * 60_000 + 1000);
  await expect(taf).toContainText('Refresh unavailable');
  await expect(taf).toContainText('Cached forecast');
  await expect(taf.locator('code')).toHaveCount(4);
  await context.setOffline(true);
  failed = false;
  await context.setOffline(false);
  await expect(taf).toContainText('Updated');
  await expect(taf).not.toContainText('Refresh unavailable');
});

const nearbyReports = [
  { icaoId: 'KBUR', lat: 34.20, lon: -118.36 },
  { icaoId: 'KLAX', lat: 33.94, lon: -118.40 },
  { icaoId: 'KTOA', lat: 33.80, lon: -118.34 },
].map(station => ({ ...report, ...station, rawTAF: rawTAF.replaceAll('KSBA', station.icaoId) }));

test('airports without a TAF choose the nearest current station, allow switching, and retain all choices offline', async ({ page, context }, testInfo) => {
  await page.clock.install({ time: now });
  await page.setViewportSize({ width: 390, height: 844 });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let offline = false, failed = false, nearbyRequests = 0;
  await context.route('**/weather/tafs.json?*', route => {
    if (offline) return route.abort('internetdisconnected');
    const params = new URL(route.request().url()).searchParams;
    if (params.has('bbox')) {
      nearbyRequests++;
      return route.fulfill({ status: failed ? 503 : 200, contentType: 'application/json', body: failed ? '' : JSON.stringify([
        ...nearbyReports,
        { ...report, icaoId: 'KOLD', lat: 34.021, lon: -118.45, validTimeFrom: from - 3600, validTimeTo: from,
          rawTAF: 'TAF KOLD EXPIRED' },
        { ...report, icaoId: 'KCNL', lat: 34.02, lon: -118.45, rawTAF: 'TAF KCNL CNL' },
        { ...report, lat: 34.43, lon: -119.84 },
      ]) });
    }
    return route.fulfill({ status: 204 });
  });
  await page.goto('/');
  await selectAirport(page, 'KSMO');
  const taf = page.getByRole('region', { name: 'TAF', exact: true });
  const selector = taf.getByRole('combobox', { name: 'TAF station' });
  await expect(selector).toHaveValue('KLAX');
  await expect(selector.locator('option')).toHaveText([
    /KLAX · .* NM SE/, /KBUR · .* NM N/, /KTOA · .* NM SE/, /KOLD · .* · Expired/,
  ]);
  await expect(taf).toContainText(/Forecast for KLAX · .* NM SE of KSMO/);
  await expect(taf.locator('code').first()).toContainText('TAF KLAX');
  await page.clock.runFor(4 * 60_000);
  await selector.selectOption('KBUR');
  await expect(taf.locator('code').first()).toContainText('TAF KBUR');
  await expect(taf).toContainText(/Forecast for KBUR · .* NM N of KSMO/);
  expect(nearbyRequests).toBe(1);
  await selector.scrollIntoViewIfNeeded();
  expect(await taf.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('nearby-taf-mobile.png') });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  failed = true;
  await page.clock.runFor(60_000 + 1000);
  await expect(taf).toContainText('Refresh unavailable');
  await expect(taf).toContainText('Cached forecast');
  await expect(selector).toHaveValue('KBUR');
  offline = true;
  await context.setOffline(true);
  await expect(taf).toContainText('Offline');
  await page.reload();
  await expect(selector).toHaveValue('KLAX');
  await expect(taf).toContainText('Cached forecast');
  await selector.selectOption('KTOA');
  await expect(taf.locator('code').first()).toContainText('TAF KTOA');
  offline = false; failed = false;
  await context.setOffline(false);
  // A service-worker reload can reset Chromium's navigator.onLine independently
  // of offline emulation. Scheduled revalidation must recover without that event.
  await page.clock.runFor(5 * 60_000 + 1000);
  await expect(taf).toContainText('Updated');
  await expect(selector).toHaveValue('KTOA');
  await expect(taf).not.toContainText('Refresh unavailable');
  expect(errors).toEqual([]);
});

test('an airport without an ICAO weather identifier can still use nearby forecasts', async ({ page, context }) => {
  await page.clock.install({ time: now });
  await context.route('**/nav/airports.geojson*', async route => {
    const response = await route.fetch();
    const body = await response.json();
    const airport = body.features.find((feature: { properties: { ident: string } }) => feature.properties.ident === 'KSMO');
    delete airport.properties.icaoId;
    await route.fulfill({ response, json: body });
  });
  const requests: string[] = [];
  let failed = true;
  await context.route('**/weather/tafs.json?*', route => {
    requests.push(new URL(route.request().url()).searchParams.has('bbox') ? 'nearby' : 'station');
    if (failed) return route.fulfill({ status: 503 });
    return route.fulfill({ json: nearbyReports });
  });
  await page.goto('/');
  await selectAirport(page, 'KSMO');
  const taf = page.getByRole('region', { name: 'TAF', exact: true });
  await expect(taf).toContainText('Nearby TAF unavailable · Refresh failed');
  await expect(taf).not.toContainText('No nearby TAF within');
  await context.setOffline(true);
  await expect(taf).toContainText('No saved nearby TAF within 50 NM · Offline');
  failed = false;
  await context.setOffline(false);
  await expect(page.getByRole('combobox', { name: 'TAF station' })).toHaveValue('KLAX');
  expect(requests).toEqual(['nearby', 'nearby']);
});

test('automatic nearby selection follows forecast expiry while offline', async ({ page, context }) => {
  await page.clock.install({ time: now });
  await context.route('**/weather/tafs.json?*', route => {
    if (!new URL(route.request().url()).searchParams.has('bbox')) return route.fulfill({ status: 204 });
    return route.fulfill({ json: nearbyReports.slice(0, 2).map(report => report.icaoId === 'KLAX'
      ? { ...report, validTimeTo: from + 120 } : report) });
  });
  await page.goto('/');
  await selectAirport(page, 'KSMO');
  const selector = page.getByRole('combobox', { name: 'TAF station' });
  await expect(selector).toHaveValue('KLAX');
  await context.setOffline(true);
  await page.clock.runFor(150_000);
  await expect(selector).toHaveValue('KBUR');
  await expect(selector.locator('option')).toHaveText([/KBUR/, /KLAX.*Expired/]);
});

test('an expired local TAF remains selectable and becomes the default when nearby forecasts expire offline', async ({ page, context }) => {
  await page.clock.install({ time: now });
  let offline = false;
  await context.route('**/weather/tafs.json?*', route => {
    if (offline) return route.abort('internetdisconnected');
    return route.fulfill({ json: new URL(route.request().url()).searchParams.has('bbox')
      ? [{ ...nearbyReports[1], validTimeTo: from + 120 }]
      : [{ ...report, icaoId: 'KSMO', validTimeFrom: from - 86400, validTimeTo: from,
        rawTAF: rawTAF.replaceAll('KSBA', 'KSMO') }] });
  });
  await page.goto('/');
  await selectAirport(page, 'KSMO');
  const taf = page.getByRole('region', { name: 'TAF', exact: true });
  const selector = taf.getByRole('combobox', { name: 'TAF station' });
  await expect(selector).toHaveValue('KLAX');
  await expect(selector.locator('option')).toHaveText([/KLAX/, /KSMO · 0.0 NM.*Expired/]);
  await selector.selectOption('KSMO');
  await page.clock.runFor(30_000);
  await expect(selector).toHaveValue('KSMO');
  await expect(taf).toContainText('Expired forecast');
  await expect(taf.locator('code').first()).toContainText('TAF KSMO');
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  offline = true;
  await context.setOffline(true);
  await page.reload();
  await expect(selector).toHaveValue('KLAX');
  await page.clock.runFor(150_000);
  await expect(selector).toHaveValue('KSMO');
  await expect(selector.locator('option')).toHaveText([/KSMO.*Expired/, /KLAX.*Expired/]);
  await expect(taf.locator('code').first()).toContainText('TAF KSMO');
});

test('a recovered airport forecast stays current when nearby discovery fails', async ({ page, context }) => {
  await page.clock.install({ time: now });
  let recovered = false, searches = 0;
  await context.route('**/weather/tafs.json?*', route => {
    if (new URL(route.request().url()).searchParams.has('bbox')) {
      searches++;
      return recovered ? route.fulfill({ status: 503 }) : route.fulfill({ json: nearbyReports });
    }
    return recovered ? route.fulfill({ json: [{ ...report, icaoId: 'KSMO', rawTAF: 'TAF KSMO TEST' }] })
      : route.fulfill({ status: 204 });
  });
  await page.goto('/');
  await selectAirport(page, 'KSMO');
  const taf = page.getByRole('region', { name: 'TAF', exact: true });
  const selector = taf.getByRole('combobox', { name: 'TAF station' });
  await expect(selector).toHaveValue('KLAX');
  await selector.selectOption('KBUR');
  recovered = true;
  await page.clock.runFor(5 * 60_000 + 1000);
  await expect(taf).toContainText('Refresh unavailable');
  await expect(selector).toHaveValue('KBUR');
  await selector.selectOption('KSMO');
  await expect(taf.locator('code').first()).toContainText('TAF KSMO TEST');
  await expect(taf).toContainText('Updated');
  await expect(taf).not.toContainText('Refresh unavailable');
  expect(searches).toBe(2);
});

test('changing airports during nearby discovery cannot replace the new airport forecast', async ({ page, context }) => {
  await page.clock.install({ time: now });
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let searching = false;
  await context.route('**/weather/tafs.json?*', async route => {
    const params = new URL(route.request().url()).searchParams;
    if (params.has('bbox')) {
      searching = true;
      await pending;
      await route.fulfill({ json: nearbyReports });
    } else if (params.get('ids') === 'KSBA') await route.fulfill({ json: [report] });
    else await route.fulfill({ status: 204 });
  });
  await page.goto('/');
  await selectAirport(page, 'KSMO');
  await expect.poll(() => searching).toBe(true);
  await selectAirport(page, 'KSBA');
  const taf = page.getByRole('region', { name: 'TAF', exact: true });
  await expect(taf.locator('code').first()).toContainText('TAF KSBA');
  release();
  await page.clock.runFor(1000);
  await expect(taf.locator('code').first()).toContainText('TAF KSBA');
  await expect(taf.getByRole('combobox')).toHaveCount(0);
});
