import { test, expect, type Page } from '@playwright/test';

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
  await context.route('**/weather/metars.geojson?*', route => {
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

test('airports without ICAO identifiers distinguish failed, offline and empty nearby searches', async ({ page, context }) => {
  await page.clock.install({ time: now });
  await context.route('**/nav/airports.geojson*', async route => {
    const response = await route.fetch();
    const body = await response.json();
    delete body.features.find((feature: { properties: { ident: string } }) => feature.properties.ident === 'KSMO').properties.icaoId;
    await route.fulfill({ response, json: body });
  });
  let failed = true;
  await context.route('**/weather/metars.geojson?*', route => route.fulfill(
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

test('own current METAR skips nearby discovery and a stale observation falls back', async ({ page, context }) => {
  await page.clock.install({ time: now });
  let searches = 0;
  await context.route('**/weather/metars.geojson?*', route => {
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
  await expect(metar.getByRole('combobox')).toHaveValue('KLAX');
  await expect(metar).not.toContainText('METAR KSMO 171800Z');
  await expect(metar.getByRole('combobox').locator('option').last()).toHaveText(/KSMO · 0.0 NM.*Stale/);
  await metar.getByRole('combobox').selectOption('KSMO');
  await expect(metar).toContainText('METAR KSMO 171800Z');
  await page.clock.runFor(61_000);
  await expect(metar.getByRole('combobox')).toHaveValue('KSMO');
});

test('a saved stale local METAR defaults ahead of stale nearby reports and survives offline reload', async ({ page, context }) => {
  await page.clock.install({ time: now });
  let offline = false;
  await context.route('**/weather/metars.geojson?*', route => {
    if (offline) return route.abort('internetdisconnected');
    const params = new URL(route.request().url()).searchParams;
    return route.fulfill({ json: collection(params.has('bbox')
      ? [report('KLAX', -118.40, 33.94, now - 4 * 3600_000)]
      : (params.get('ids') ?? '').split(',').includes('KSMO')
        ? [report('KSMO', -118.45, 34.02, now - 2.5 * 3600_000)] : []) });
  });
  await page.goto('/');
  await selectAirport(page, 'KSMO');
  const metar = page.getByRole('region', { name: 'METAR', exact: true });
  const selector = metar.getByRole('combobox', { name: 'METAR station' });
  await expect(selector.locator('option')).toHaveText([/KSMO · 0.0 NM.*Stale/, /KLAX.*Stale/]);
  await expect(selector).toHaveValue('KSMO');
  await expect(metar).toContainText('METAR KSMO 171800Z');
  await expect(metar).toContainText('Stale');
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
  await context.route('**/weather/metars.geojson?*', route => route.fulfill({ json: collection(
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
  await context.route('**/weather/metars.geojson?*', async route => {
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
