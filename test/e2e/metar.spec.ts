import { test, expect, type Page } from '@playwright/test';
import { countWatches, mockGps, sendFix } from './ownship-fixture';

const now = Date.parse('2026-09-17T18:00:00Z');
const report = (id: string, lon: number, lat: number, time = now) => ({
  type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] },
  properties: { id, obsTime: time / 1000,
    rawOb: `METAR ${id} 171800Z 28010KT 10SM ${id === 'KLAX' ? 'SCT003 BKN012 OVC030'
      : id === 'KBUR' ? 'BKN025' : id === 'KSBA' ? 'OVC009' : 'SCT030'}`,
    wdir: 280, wspd: 10, visib: 10,
    ...(id === 'KLAX' ? { clouds: [{ cover: 'BKN', base: 12 }] }
      : id === 'KBUR' ? { ceil: 25 } : {}),
  },
});
const nearby = [report('KBUR', -118.36, 34.20), report('KLAX', -118.40, 33.94), report('KTOA', -118.34, 33.80)];
const collection = (features: ReturnType<typeof report>[]) => ({ type: 'FeatureCollection', features });
async function selectAirport(page: Page, id: string) {
  await page.getByLabel('Search FAA navigation data').fill(id);
  await page.locator('.search-results button').filter({ hasText: id }).click();
}

test('flight-category legend stays mounted through GPS position and track updates', async ({ page, context }) => {
  await page.clock.install({ time: now });
  await mockGps(page);
  await page.addInitScript(() => {
    localStorage.setItem('zlayers-map-preferences-v1', JSON.stringify({ version: 2, chartBase: '', ownshipEnabled: true }));
    localStorage.setItem('zlayers-map-view-v1', JSON.stringify({ version: 1, center: [-119.84, 34.43], zoom: 11, bearing: 0, pitch: 0 }));
  });
  await context.route('**/api/weather/metars.geojson?*', route => route.fulfill({
    json: collection([report('KSBA', -119.84, 34.43)]),
  }));
  await page.goto('/');
  await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false');
  await expect.poll(() => countWatches(page)).toBe(1);
  const legend = page.getByLabel('METAR flight categories', { exact: true });
  await expect(legend).toBeVisible();
  const original = (await legend.elementHandle())!;
  await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1000);
  // Below the AHRS heading-aid gate, this exercises GPS-only camera following.
  await sendFix(page, { longitude: -119.84, latitude: 34.43, heading: 0, speed: 5 });
  await page.getByRole('button', { name: 'Track up', exact: true }).click();
  const camera = () => page.evaluate(() => JSON.parse(localStorage.getItem('zlayers-map-view-v1')!) as {
    center: [number, number]; bearing: number;
  });
  for (const [longitude, heading] of [[-119.839, 15], [-119.838, 30], [-119.837, 45]] as const) {
    // Damping advances on fresh samples, not while an assertion polls. Keep
    // acquisition times deterministic, let the 1.5s filter settle within its 2°
    // deadband, and allow the automatic camera save to flush.
    for (let sample = 0; sample < 10; sample++) {
      await page.clock.runFor(1000);
      await sendFix(page, { longitude, latitude: 34.43, heading, speed: 5 });
    }
    await page.clock.runFor(1000);
    await expect.poll(async () => (await camera()).center[0]).toBeCloseTo(longitude, 6);
    await expect.poll(async () => Math.abs(((await camera()).bearing - heading + 540) % 360 - 180)).toBeLessThan(2);
    await expect(legend).toBeVisible();
    expect(await original.evaluate(element => element.isConnected), 'GPS movement must not unmount the legend').toBe(true);
  }
});

test('raw METAR, exact decoded values and category recover from the reverted NWS cache and survive reload', async ({ page, context }, testInfo) => {
  await page.clock.install({ time: now });
  const coded = report('KSBA', -119.84, 34.43, now - 15 * 60_000);
  coded.properties.rawOb = 'METAR KSBA 171745Z 28010KT 3SM BKN010 A2992 RMK AO2';
  coded.properties.visib = 3;
  Object.assign(coded.properties, { clouds: [{ cover: 'BKN', base: 10 }] });
  await context.addInitScript(sensor => {
    if (!localStorage.getItem('nws-regression-seeded')) {
      localStorage.setItem('zlayer-plugin:metar:metars', JSON.stringify({ type: 'FeatureCollection', features: [sensor] }));
      localStorage.setItem('nws-regression-seeded', 'true');
    }
  }, { ...coded, properties: { ...coded.properties, source: 'NWS', obsTime: now / 1000, rawOb: '', wspd: null } });
  let offline = false;
  await context.route('**/api/weather/metars.geojson?*', route => offline ? route.abort('internetdisconnected')
    : route.fulfill({ json: collection([coded]) }));
  const nwsRequests: string[] = [];
  page.on('request', request => { if (new URL(request.url()).hostname === 'api.weather.gov') nwsRequests.push(request.url()); });
  await page.goto('/');
  await selectAirport(page, 'KSBA');
  const metar = page.getByRole('region', { name: 'METAR', exact: true });
  const value = (label: string) => metar.locator('dl > div').filter({ has: page.locator('dt', { hasText: new RegExp(`^${label}$`) }) }).locator('dd');
  await expect(value('Raw')).toHaveText(coded.properties.rawOb);
  await expect(value('Ceiling')).toHaveText('1,000 ft');
  await expect(value('Visibility')).toHaveText('3 SM');
  await expect(metar.locator('dt')).toHaveText(['Wind', 'Visibility', 'Ceiling', 'Altimeter', 'Raw']);
  await expect(value('Altimeter')).toHaveText('29.92 inHg');
  await expect(value('Raw')).toHaveAttribute('data-flight-category', 'MVFR');
  await expect(value('Wind')).toContainText('/280°T 10 kt');
  await expect(metar).toContainText('Updated');
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const positions = await metar.locator('dl > div').evaluateAll(cells => cells.map(cell => {
      const rect = cell.getBoundingClientRect();
      return { x: rect.x, y: rect.y };
    }));
    const [wind, visibility, ceiling, altimeter, raw] = positions;
    expect(wind!.y).toBe(visibility!.y);
    expect(ceiling!.y).toBe(altimeter!.y);
    expect(wind!.x).toBe(ceiling!.x);
    expect(visibility!.x).toBe(altimeter!.x);
    expect(wind!.x).toBeLessThan(visibility!.x);
    expect(wind!.y).toBeLessThan(ceiling!.y);
    expect(ceiling!.y).toBeLessThan(raw!.y);
    await metar.screenshot({ path: testInfo.outputPath(`metar-grid-${width}.png`) });
  }
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  offline = true;
  await context.setOffline(true);
  await page.reload();
  await expect(value('Raw')).toHaveText(coded.properties.rawOb);
  await expect(value('Ceiling')).toHaveText('1,000 ft');
  await expect(value('Visibility')).toHaveText('3 SM');
  await expect(value('Altimeter')).toHaveText('29.92 inHg');
  await expect(value('Raw')).toHaveAttribute('data-flight-category', 'MVFR');
  await expect(metar).toContainText('Cached report');
  expect(nwsRequests).toEqual([]);
});

test('missing METARs default to nearest current report, switch without fetching, and retain choices offline', async ({ page, context }, testInfo) => {
  await page.clock.install({ time: now });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/nav/airports.geojson*', async route => {
    const response = await route.fetch();
    const body = await response.json();
    body.features.find((feature: { properties: { ident: string } }) => feature.properties.ident === 'KSMO')
      .properties.runways = [{ id: '03/21', ends: [{ id: '03', trueHeadingDeg: 30 }] }];
    await route.fulfill({ response, json: body });
  });
  let offline = false, failed = false, searches = 0;
  await context.route('**/api/weather/metars.geojson?*', route => {
    if (offline) return route.abort('internetdisconnected');
    if (!new URL(route.request().url()).searchParams.has('bbox')) return route.fulfill({ json: collection([]) });
    searches++;
    return failed ? route.fulfill({ status: 400 }) : route.fulfill({ json: collection([
      ...nearby, report('KOLD', -118.45, 34.021, now - 3 * 3600_000), report('KSBA', -119.84, 34.43),
    ]) });
  });
  await page.goto('/');
  await selectAirport(page, 'KSMO');
  const metar = page.getByRole('region', { name: 'METAR', exact: true });
  const selector = metar.getByRole('combobox', { name: 'METAR station' });
  await expect(selector).toHaveValue('KLAX');
  await expect(selector.locator('option')).toHaveText([
    /KLAX · .* NM SE/, /KBUR · .* NM N/, /KTOA · .* NM SE/, /KOLD · .* · Stale/,
  ]);
  await expect(metar).toContainText(/Observation for KLAX · .* NM SE of KSMO/);
  await expect(metar).toContainText('METAR KLAX 171800Z');
  await expect(metar).toContainText('269°M/280°T 10 kt');
  const ceiling = metar.locator('dl > div').filter({ has: page.locator('dt', { hasText: /^Ceiling$/ }) }).locator('dd');
  await expect(ceiling).toHaveText('1,200 ft');
  await expect(page.locator('.airport-runways')).toContainText('METAR wind unavailable');
  await selector.selectOption('KBUR');
  await expect(metar).toContainText('METAR KBUR 171800Z');
  await expect(ceiling).toHaveText('2,500 ft');
  expect(searches).toBe(1);
  await selector.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('nearby-metar-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await selector.scrollIntoViewIfNeeded();
  expect(await metar.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('nearby-metar-mobile.png') });
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  failed = true;
  await page.clock.runFor(61_000);
  await expect(metar).toContainText('Refresh unavailable');
  await expect(metar).toContainText('Cached report');
  await expect(selector).toHaveValue('KBUR');
  offline = true;
  await context.setOffline(true);
  await expect(metar).toContainText('Offline');
  await page.reload();
  await expect(selector).toHaveValue('KLAX');
  await expect(metar).toContainText('Cached report');
  await expect(ceiling).toHaveText('1,200 ft');
  await expect(metar).toContainText('269°M/280°T 10 kt');
  await selector.selectOption('KTOA');
  await expect(metar).toContainText('METAR KTOA 171800Z');
  await expect(ceiling).toHaveText('None reported');
  offline = false; failed = false;
  await context.setOffline(false);
  await page.clock.runFor(61_000);
  await expect(metar).toContainText('Updated');
  await expect(selector).toHaveValue('KTOA');
  await expect(metar).not.toContainText('Refresh unavailable');
  expect(errors).toEqual([]);
});

test('METAR wind retains true direction when magnetic data is unavailable and recovers on reconnect', async ({ page, context }) => {
  await page.clock.install({ time: now });
  let unavailable = true;
  await context.route('**/nav/magnetic-model.json*', route => unavailable
    ? route.fulfill({ status: 404 }) : route.continue());
  await context.route('**/api/weather/metars.geojson?*', route => route.fulfill({
    json: collection([report('KSMO', -118.45, 34.02)]),
  }));
  await page.goto('/');
  await selectAirport(page, 'KSMO');
  const metar = page.getByRole('region', { name: 'METAR', exact: true });
  await expect(metar).toContainText('—/280°T 10 kt');
  await context.setOffline(true);
  unavailable = false;
  await context.setOffline(false);
  await expect(metar).toContainText('269°M/280°T 10 kt');
});

test('airports without ICAO identifiers distinguish failed, offline and empty nearby searches', async ({ page, context }) => {
  await page.clock.install({ time: now });
  await context.route('**/nav/airports.geojson*', async route => {
    const response = await route.fetch();
    const body = await response.json();
    delete body.features.find((feature: { properties: { ident: string } }) => feature.properties.ident === 'KSMO').properties.icaoId;
    await route.fulfill({ response, json: body });
  });
  let failed = true;
  await context.route('**/api/weather/metars.geojson?*', route => route.fulfill(
    new URL(route.request().url()).searchParams.has('bbox') && failed ? { status: 400 } : { json: collection([]) }));
  await page.goto('/');
  await selectAirport(page, 'KSMO');
  const metar = page.getByRole('region', { name: 'METAR', exact: true });
  await expect(metar).toContainText('Nearby METAR unavailable · Refresh failed');
  await context.setOffline(true);
  await expect(metar).toContainText('No saved nearby METAR within 50 NM · Offline');
  failed = false;
  await context.setOffline(false);
  await page.clock.runFor(61_000);
  await expect(metar).toContainText('No nearby METAR within 50 NM.');
});

test('own METAR stays selected when stale, with nearby reports available for manual selection', async ({ page, context }) => {
  await page.clock.install({ time: now });
  let searches = 0;
  await context.route('**/api/weather/metars.geojson?*', route => {
    const params = new URL(route.request().url()).searchParams;
    if (params.has('bbox')) { searches++; return route.fulfill({ json: collection(nearby) }); }
    return route.fulfill({ json: collection((params.get('ids') ?? '').split(',').flatMap(id => id === 'KSBA'
      ? [report('KSBA', -119.84, 34.43)] : id === 'KSMO' ? [report('KSMO', -118.45, 34.02, now - 3 * 3600_000)] : [])) });
  });
  await page.goto('/');
  await selectAirport(page, 'KSBA');
  const metar = page.getByRole('region', { name: 'METAR', exact: true });
  await expect(metar).toContainText('METAR KSBA 171800Z');
  await expect(metar.locator('dl > div').filter({ hasText: 'Ceiling' })).toContainText('900 ft');
  await expect(metar.getByRole('combobox')).toHaveCount(0);
  expect(searches).toBe(0);
  await selectAirport(page, 'KSMO');
  await expect(metar.getByRole('combobox')).toHaveValue('KSMO');
  await expect(metar.getByRole('combobox').locator('option').first()).toHaveText(/KSMO · 0.0 NM.*Stale/);
  await expect(metar).toContainText('METAR KSMO 171800Z');
  await expect(metar).toContainText('Cached report');
  await expect(metar).toContainText('3h old');
  await expect.poll(() => searches).toBeGreaterThan(0);
  await metar.getByRole('combobox').selectOption('KLAX');
  await expect(metar).toContainText('METAR KLAX 171800Z');
  await page.clock.runFor(61_000);
  await expect(metar.getByRole('combobox')).toHaveValue('KLAX');
});

test('a five-hour-old local METAR defaults ahead of current nearby reports and survives offline reload', async ({ page, context }) => {
  await page.clock.install({ time: now });
  let offline = false;
  await context.route('**/api/weather/metars.geojson?*', route => {
    if (offline) return route.abort('internetdisconnected');
    const params = new URL(route.request().url()).searchParams;
    return route.fulfill({ json: collection(params.has('bbox')
      ? [report('KLAX', -118.40, 33.94)]
      : (params.get('ids') ?? '').split(',').includes('KSMO')
        ? [report('KSMO', -118.45, 34.02, now - 5 * 3600_000)] : []) });
  });
  await page.goto('/');
  await selectAirport(page, 'KSMO');
  const metar = page.getByRole('region', { name: 'METAR', exact: true });
  const selector = metar.getByRole('combobox', { name: 'METAR station' });
  await expect(selector.locator('option')).toHaveText([/KSMO · 0.0 NM.*Stale/, /KLAX/]);
  await expect(selector).toHaveValue('KSMO');
  await expect(metar).toContainText('METAR KSMO 171800Z');
  await expect(metar).toContainText('Stale');
  await expect(metar).toContainText('Cached report');
  await expect(metar).toContainText('5h old');
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  offline = true;
  await context.setOffline(true);
  await selector.selectOption('KLAX');
  await page.clock.runFor(30_000);
  await expect(selector).toHaveValue('KLAX');
  await expect(metar).toContainText('METAR KLAX 171800Z');
  await page.reload();
  await expect(selector).toHaveValue('KSMO');
  await expect(selector.locator('option')).toHaveCount(2);
  await expect(metar).toContainText('Cached report');
  await expect(metar).toContainText('METAR KSMO 171800Z');
});

test('offline default follows observation age, while manual choices remain selected', async ({ page, context }) => {
  await page.clock.install({ time: now });
  await context.route('**/api/weather/metars.geojson?*', route => route.fulfill({ json: collection(
    new URL(route.request().url()).searchParams.has('bbox')
      ? [nearby[0]!, report('KLAX', -118.40, 33.94, now - 2 * 3600_000 + 120_000)] : []) }));
  await page.goto('/');
  await selectAirport(page, 'KSMO');
  const selector = page.getByRole('combobox', { name: 'METAR station' });
  await expect(selector).toHaveValue('KLAX');
  await context.setOffline(true);
  await page.clock.runFor(150_000);
  await expect(selector).toHaveValue('KBUR');
  await expect(selector.locator('option')).toHaveText([/KBUR/, /KLAX.*Stale/]);
  await selector.selectOption('KLAX');
  await page.clock.runFor(30_000);
  await expect(selector).toHaveValue('KLAX');
});

test('changing airports during discovery cannot replace the new airport report', async ({ page, context }) => {
  await page.clock.install({ time: now });
  let release!: () => void, searching = false;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await context.route('**/api/weather/metars.geojson?*', async route => {
    const params = new URL(route.request().url()).searchParams;
    if (params.has('bbox')) {
      searching = true; await pending;
      await route.fulfill({ json: collection(nearby) });
    } else await route.fulfill({ json: collection((params.get('ids') ?? '').split(',').includes('KSBA')
      ? [report('KSBA', -119.84, 34.43)] : []) });
  });
  await page.goto('/');
  await selectAirport(page, 'KSMO');
  await expect.poll(() => searching).toBe(true);
  await selectAirport(page, 'KSBA');
  const metar = page.getByRole('region', { name: 'METAR', exact: true });
  await expect(metar).toContainText('METAR KSBA 171800Z');
  release();
  await page.clock.runFor(1000);
  await expect(metar).toContainText('METAR KSBA 171800Z');
  await expect(metar.getByRole('combobox')).toHaveCount(0);
});
