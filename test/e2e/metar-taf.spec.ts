import { test, expect, type Page } from '@playwright/test';

const now = Date.parse('2026-09-17T18:00:00Z');
const stations = [
  { id: 'KLAX', coordinates: [-118.40, 33.94] },
  { id: 'KBUR', coordinates: [-118.36, 34.20] },
  { id: 'KTOA', coordinates: [-118.34, 33.80] },
];
const metar = ({ id, coordinates }: typeof stations[number]) => ({
  type: 'Feature', geometry: { type: 'Point', coordinates },
  properties: { id, obsTime: now / 1000, rawOb: `METAR ${id} 171800Z 28010KT 10SM BKN012`, wdir: 280, wspd: 10, visib: 10 },
});
const taf = ({ id, coordinates }: typeof stations[number]) => ({
  icaoId: id, lon: coordinates[0], lat: coordinates[1], issueTime: new Date(now).toISOString(),
  validTimeFrom: now / 1000, validTimeTo: now / 1000 + 86400,
  rawTAF: `TAF ${id} 171800Z 1718/1818 28010KT P6SM SCT030`, fcsts: [],
});
async function selectAirport(page: Page, id: string) {
  await page.getByLabel('Search FAA navigation data').fill(id);
  await page.locator('.search-results button').filter({ hasText: id }).click();
}

test('combined airport reports keep independent selections and refresh schedules, and reset together on airport changes', async ({ page, context }) => {
  await page.clock.install({ time: now });
  const searches = { metar: 0, taf: 0 };
  const own = { id: 'KSBA', coordinates: [-119.84, 34.43] };
  await context.route('**/weather/metars.geojson?*', route => {
    const params = new URL(route.request().url()).searchParams;
    const nearby = params.has('bbox');
    if (nearby) searches.metar++;
    const reports = nearby ? stations : (params.get('ids') ?? '').split(',').includes('KSBA') ? [own] : [];
    return route.fulfill({ json: { type: 'FeatureCollection', features: reports.map(metar) } });
  });
  await context.route('**/weather/tafs.json?*', route => {
    const params = new URL(route.request().url()).searchParams;
    const nearby = params.has('bbox');
    if (nearby) searches.taf++;
    return route.fulfill({ json: (nearby ? stations : params.get('ids') === 'KSBA' ? [own] : []).map(taf) });
  });
  await page.goto('/');
  await selectAirport(page, 'KSMO');
  const observation = page.getByRole('region', { name: 'METAR', exact: true });
  const forecast = page.getByRole('region', { name: 'TAF', exact: true });
  const metarStation = observation.getByRole('combobox', { name: 'METAR station' });
  const tafStation = forecast.getByRole('combobox', { name: 'TAF station' });
  await expect(metarStation).toHaveValue('KLAX');
  await expect(tafStation).toHaveValue('KLAX');
  expect(searches).toEqual({ metar: 1, taf: 1 });

  // A manual choice shortly before a refresh must not postpone its timer.
  await page.clock.runFor(45_000);
  await metarStation.selectOption('KBUR');
  await expect(observation).toContainText('METAR KBUR');
  await expect(tafStation).toHaveValue('KLAX');
  expect(searches).toEqual({ metar: 1, taf: 1 });
  await page.clock.runFor(16_000);
  await expect.poll(() => searches.metar).toBe(2);
  expect(searches.taf).toBe(1);
  await expect(metarStation).toHaveValue('KBUR');

  await page.clock.runFor(3 * 60_000);
  await tafStation.selectOption('KTOA');
  await expect(forecast).toContainText('TAF KTOA');
  await expect(metarStation).toHaveValue('KBUR');
  expect(searches.taf).toBe(1);
  await page.clock.runFor(61_000);
  await expect.poll(() => searches.taf).toBe(2);
  expect(searches.metar).toBeGreaterThan(2);
  await expect(metarStation).toHaveValue('KBUR');
  await expect(tafStation).toHaveValue('KTOA');

  await expect(observation).toHaveAttribute('aria-busy', 'false');
  await expect(forecast).toHaveAttribute('aria-busy', 'false');
  await context.setOffline(true);
  await expect(observation).toContainText('Offline');
  await expect(forecast).toContainText('Offline');
  const beforeOffline = { ...searches };
  await page.clock.runFor(6 * 60_000);
  expect(searches).toEqual(beforeOffline);
  await expect(metarStation).toHaveValue('KBUR');
  await expect(tafStation).toHaveValue('KTOA');

  await context.setOffline(false);
  await selectAirport(page, 'KSBA');
  await expect(observation).toContainText('METAR KSBA');
  await expect(forecast).toContainText('TAF KSBA');
  await expect(metarStation).toHaveCount(0);
  await expect(tafStation).toHaveCount(0);
  await selectAirport(page, 'KSMO');
  await expect(metarStation).toHaveValue('KLAX');
  await expect(tafStation).toHaveValue('KLAX');
});

test('cached reports open idle offline, resume on reconnect, and stop refreshing when the card closes', async ({ page, context }) => {
  await page.clock.install({ time: now });
  const requests = { metar: 0, taf: 0 };
  let offline = false;
  await context.route('**/weather/metars.geojson?*', route => {
    requests.metar++;
    if (offline) return route.abort('internetdisconnected');
    const nearby = new URL(route.request().url()).searchParams.has('bbox');
    return route.fulfill({ json: { type: 'FeatureCollection', features: nearby ? stations.map(metar) : [] } });
  });
  await context.route('**/weather/tafs.json?*', route => {
    requests.taf++;
    if (offline) return route.abort('internetdisconnected');
    const nearby = new URL(route.request().url()).searchParams.has('bbox');
    return route.fulfill({ json: nearby ? stations.map(taf) : [] });
  });
  await page.goto('/');
  await selectAirport(page, 'KSMO');
  const observation = page.getByRole('region', { name: 'METAR', exact: true });
  const forecast = page.getByRole('region', { name: 'TAF', exact: true });
  await expect(observation.getByRole('combobox')).toHaveValue('KLAX');
  await expect(forecast.getByRole('combobox')).toHaveValue('KLAX');
  await expect(observation).toHaveAttribute('aria-busy', 'false');
  await expect(forecast).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'Close detail', exact: true }).click();
  offline = true;
  await context.setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
  await selectAirport(page, 'KSMO');
  await expect(observation).toContainText('Cached report');
  await expect(forecast).toContainText('Cached forecast');
  for (const section of [observation, forecast]) {
    await expect(section).toContainText('Offline');
    await expect(section).toHaveAttribute('aria-busy', 'false');
    await expect(section).not.toContainText('Refreshing');
  }
  const beforeIdle = { ...requests };
  await page.clock.runFor(6 * 60_000);
  expect(requests).toEqual(beforeIdle);
  offline = false;
  await context.setOffline(false);
  await expect(observation).toContainText('Updated');
  await expect(forecast).toContainText('Updated');
  await expect(observation).toHaveAttribute('aria-busy', 'false');
  await expect(forecast).toHaveAttribute('aria-busy', 'false');

  // Nearby searches belong to the open card, independently of map METAR demand.
  let nearbyRequests = 0;
  page.on('request', request => {
    if (request.url().includes('/weather/') && new URL(request.url()).searchParams.has('bbox')) nearbyRequests++;
  });
  await page.getByRole('button', { name: 'Close detail', exact: true }).click();
  await expect(observation).toHaveCount(0);
  await expect(forecast).toHaveCount(0);
  await page.clock.runFor(6 * 60_000);
  expect(nearbyRequests).toBe(0);
  await selectAirport(page, 'KSMO');
  await expect(observation).toContainText('METAR KLAX');
  await expect(forecast).toContainText('TAF KLAX');
  await expect.poll(() => nearbyRequests).toBe(2);
});

test('hidden cards stay idle, cancel delayed nearby reports, and resume cleanly when visible', async ({ page, context }) => {
  await page.clock.install({ time: now });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const searches = { metar: 0, taf: 0 };
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const obsolete = { id: 'KOLD', coordinates: [-118.45, 34.02] };
  await context.route('**/weather/metars.geojson?*', async route => {
    const nearby = new URL(route.request().url()).searchParams.has('bbox');
    const delayed = nearby && ++searches.metar === 1;
    if (delayed) await pending;
    await route.fulfill({ json: { type: 'FeatureCollection', features: !nearby ? [] : (delayed ? [obsolete] : stations).map(metar) } });
  });
  await context.route('**/weather/tafs.json?*', async route => {
    const nearby = new URL(route.request().url()).searchParams.has('bbox');
    const delayed = nearby && ++searches.taf === 1;
    if (delayed) await pending;
    await route.fulfill({ json: !nearby ? [] : (delayed ? [obsolete] : stations).map(taf) });
  });
  const visibility = (state: 'hidden' | 'visible') => page.evaluate(value => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
  try {
    await page.goto('/');
    await visibility('hidden');
    await selectAirport(page, 'KSMO');
    const observation = page.getByRole('region', { name: 'METAR', exact: true });
    const forecast = page.getByRole('region', { name: 'TAF', exact: true });
    await page.clock.runFor(6 * 60_000);
    expect(searches).toEqual({ metar: 0, taf: 0 });
    await expect(observation).toHaveAttribute('aria-busy', 'false');
    await expect(forecast).toHaveAttribute('aria-busy', 'false');

    await visibility('visible');
    await expect.poll(() => searches).toEqual({ metar: 1, taf: 1 });
    await expect(observation).toHaveAttribute('aria-busy', 'true');
    await expect(forecast).toHaveAttribute('aria-busy', 'true');
    await visibility('hidden');
    await expect(observation).toHaveAttribute('aria-busy', 'false');
    await expect(forecast).toHaveAttribute('aria-busy', 'false');
    release();
    await page.clock.runFor(6 * 60_000);
    expect(searches).toEqual({ metar: 1, taf: 1 });
    for (const section of [observation, forecast]) {
      await expect(section.getByRole('combobox')).toHaveCount(0);
      await expect(section).not.toContainText('KOLD');
      await expect(section).not.toContainText('Refresh unavailable');
    }

    await visibility('visible');
    await expect(observation.getByRole('combobox')).toHaveValue('KLAX');
    await expect(forecast.getByRole('combobox')).toHaveValue('KLAX');
    expect(searches).toEqual({ metar: 2, taf: 2 });
    await page.clock.runFor(61_000);
    await expect.poll(() => searches.metar).toBe(3);
    expect(searches.taf).toBe(2);
    expect(errors).toEqual([]);
  } finally {
    release();
  }
});
