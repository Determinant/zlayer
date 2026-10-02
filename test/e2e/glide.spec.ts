import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { terrainPng } from './terrain-fixture.mjs';
import type { GeoJSONSource } from 'maplibre-gl';

async function airports(context: BrowserContext) {
  await context.route('**/nav/airports.geojson*', async route => {
    const response = await route.fetch(), body = await response.json();
    body.features.forEach((feature: { geometry: { coordinates: number[] }; properties: Record<string, unknown> }, i: number) => {
      feature.geometry.coordinates = [-119.84 + i * 0.08, 34.43];
      Object.assign(feature.properties, { elevationFt: 100, status: i === 2 ? 'C' : 'O', use: i === 1 ? 'PR' : 'PU',
        runways: [{ id: '09/27', lengthFt: 1800, widthFt: 40, surface: i === 1 ? 'TURF' : 'ASPH' }] });
    });
    await route.fulfill({ response, json: body });
  });
  await context.route('**/terrain/*/*/*.png', route => {
    const match = /terrain\/(\d+)\/(\d+)\/(\d+)\.png/.exec(route.request().url())!;
    return route.fulfill({ contentType: 'image/png', body: terrainPng(Number(match[1]), Number(match[2]), Number(match[3]), () => 0) });
  });
}

async function controlGlideResults(page: Page) {
  await page.addInitScript(() => {
    const NativeWorker = Worker, pending: (() => void)[] = [];
    window.addEventListener('release-glide-results', () => {
      document.documentElement.dataset.holdGlideResults = 'false';
      for (const deliver of pending.splice(0)) deliver();
      document.documentElement.dataset.pendingGlideResults = '0';
    });
    window.Worker = class extends NativeWorker {
      readonly glide: boolean;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options); this.glide = String(url).includes('glide.worker');
        if (this.glide) this.addEventListener('message', event => {
          const ownship = event.data?.value?.ownship?.line as GeoJSON.FeatureCollection<GeoJSON.MultiLineString> | undefined;
          const points = ownship?.features.flatMap(feature => feature.geometry.coordinates.flat());
          if (points?.length) document.documentElement.dataset.rangeTargetEast = String(Math.max(...points.map(point => point[0]!)));
          if (!event.data?.value?.work || document.documentElement.dataset.holdGlideResults !== 'true') return;
          event.stopImmediatePropagation();
          pending.push(() => this.dispatchEvent(new MessageEvent('message', { data: event.data })));
          document.documentElement.dataset.pendingGlideResults = String(pending.length);
        });
      }
      override postMessage(message: unknown, options: Transferable[] | StructuredSerializeOptions = []) {
        if (this.glide && (message as { path?: string[] }).path?.[0] === 'calculate') {
          document.documentElement.dataset.glideCalculations = String(Number(document.documentElement.dataset.glideCalculations ?? 0) + 1);
        }
        if (this.glide && (message as { path?: string[] }).path?.[0] === 'cancel') {
          document.documentElement.dataset.glideCancellations = String(Number(document.documentElement.dataset.glideCancellations ?? 0) + 1);
        }
        if (Array.isArray(options)) super.postMessage(message, options); else super.postMessage(message, options);
      }
    };
  });
}

test('airport coverage switches independently, preserves ownship, rejects late results and persists off', async ({ page, context }) => {
  await airports(context);
  await controlGlideResults(page);
  let airportReads = 0;
  page.on('request', request => { if (request.url().includes('/nav/airports.geojson')) airportReads++; });
  await page.goto('/test/browser/glide.html');
  await page.waitForFunction(() => !!window.glideAudit);
  const master = page.getByRole('switch', { name: 'Show glide coverage' });
  const airportSwitch = page.getByRole('switch', { name: 'Show airport coverage' });
  const state = page.getByTestId('glide-state');
  const data = (id: string) => page.evaluate(async id =>
    await window.glideAudit.map.getSource<GeoJSONSource>(id)!.getData() as GeoJSON.FeatureCollection, id);
  await expect(airportSwitch).toHaveAttribute('aria-checked', 'false');
  await page.evaluate(() => window.glideAudit.ownship([-119.78, 34.48]));
  await master.click();
  await expect.poll(async () => (await data('glide-ownship-area')).features.length).toBe(1);
  const ownship = await data('glide-ownship-area');
  expect((await data('glide-areas')).features).toEqual([]);
  expect(airportReads, 'ownship-only planning must not acquire the airport catalog').toBe(0);
  await expect(page.getByRole('status', { name: 'Glide coverage status' })).toHaveText('Airport coverage is off');

  await page.evaluate(() => { document.documentElement.dataset.holdGlideResults = 'true'; });
  await airportSwitch.click();
  await expect(page.locator('html')).toHaveAttribute('data-pending-glide-results', '1');
  await airportSwitch.click();
  await page.evaluate(() => window.dispatchEvent(new Event('release-glide-results')));
  await expect(state).toHaveAttribute('data-state', 'ready');
  expect((await data('glide-areas')).features).toEqual([]);
  expect(await data('glide-ownship-area')).toEqual(ownship);

  await airportSwitch.click();
  await expect.poll(async () => (await data('glide-airports')).features.length).toBe(2);
  await airportSwitch.click();
  await expect.poll(async () => (await data('glide-airports')).features.length).toBe(0);
  expect((await data('glide-areas')).features).toEqual([]);
  expect(await data('glide-ownship-area')).toEqual(ownship);
  await expect(master).toHaveAttribute('aria-checked', 'true');
  await master.click(); await master.click();
  await expect(airportSwitch).toHaveAttribute('aria-checked', 'false');
  await expect.poll(async () => (await data('glide-ownship-area')).features.length).toBe(1);
  const reads = airportReads;
  await page.reload();
  await expect(master).toHaveAttribute('aria-checked', 'true');
  await expect(airportSwitch).toHaveAttribute('aria-checked', 'false');
  await page.waitForFunction(() => !!window.glideAudit);
  await page.evaluate(() => window.glideAudit.ownship([-119.78, 34.48]));
  await expect.poll(async () => (await data('glide-ownship-area')).features.length).toBe(1);
  expect(airportReads).toBe(reads);
  await expect(page.getByTestId('errors')).toBeEmpty();
});

test('reverse airport coverage merges, grows, clears on disable and survives map remounts', async ({ page, context }, testInfo) => {
  await airports(context);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/test/browser/glide.html');
  await page.getByRole('switch', { name: 'Show airport coverage' }).click();
  const panel = page.getByRole('region', { name: 'Glide Planner', exact: true });
  await panel.getByRole('switch', { name: 'Show glide coverage' }).click();
  await expect(page.getByTestId('glide-state')).toHaveAttribute('data-state', 'ready');
  const inspect = () => page.evaluate(async () => {
    const map = window.glideAudit.map;
    const data = await map.getSource<GeoJSONSource>('glide-areas')!.getData() as GeoJSON.FeatureCollection<GeoJSON.MultiPolygon>;
    const airports = await map.getSource<GeoJSONSource>('glide-airports')!.getData() as GeoJSON.FeatureCollection;
    const coordinates = data.features.flatMap(feature => feature.geometry.coordinates);
    const xs = coordinates.flat(2).map(p => p[0]!);
    return { polygons: coordinates.length, rings: coordinates.map(p => p.length), airportCount: airports.features.length,
      width: xs.length ? Math.max(...xs) - Math.min(...xs) : 0 };
  });
  const first = await inspect();
  expect(first.polygons).toBe(1); expect(first.rings).toEqual([1]); expect(first.airportCount).toBe(2);
  await panel.getByRole('slider', { name: 'Glide start altitude' }).fill('9500');
  await expect(page.getByTestId('glide-state')).toHaveAttribute('data-state', 'ready');
  await expect.poll(async () => (await inspect()).width).toBeGreaterThan(first.width * 1.25);
  await expect.poll(() => page.evaluate(() => window.glideAudit.map.queryRenderedFeatures({ layers: ['glide-outline'] }).length)).toBeGreaterThan(0);
  await page.screenshot({ path: testInfo.outputPath('glide-merged.png') });
  await panel.getByRole('switch', { name: 'Show glide coverage' }).click();
  await expect.poll(async () => (await inspect()).polygons).toBe(0);
  await panel.getByRole('switch', { name: 'Show glide coverage' }).click();
  await expect(page.getByTestId('glide-state')).toHaveAttribute('data-state', 'ready');
  await page.evaluate(() => window.glideAudit.remount());
  await expect(page.getByTestId('glide-state')).toHaveAttribute('data-state', 'ready');
  expect((await inspect()).polygons).toBe(1);
  await expect(page.getByTestId('errors')).toBeEmpty(); expect(errors).toEqual([]);
});

test('missing terrain never draws optimistic circles and retry recovers the open planner', async ({ page, context }) => {
  await airports(context);
  await context.route('**/terrain/*/*/*.png', route => route.fulfill({ status: 404 }));
  await page.goto('/test/browser/glide.html');
  await page.getByRole('switch', { name: 'Show airport coverage' }).click();
  await page.getByRole('switch', { name: 'Show glide coverage' }).click();
  await expect(page.getByTestId('glide-state')).toHaveAttribute('data-state', 'partial', { timeout: 30_000 });
  const count = () => page.evaluate(async () => {
    const data = await window.glideAudit.map.getSource<GeoJSONSource>('glide-areas')!.getData() as GeoJSON.FeatureCollection;
    return data.features.length;
  });
  expect(await count()).toBe(0);
  await context.unroute('**/terrain/*/*/*.png');
  await airports(context);
  await page.getByRole('button', { name: 'Retry glide coverage' }).click();
  await expect(page.getByTestId('glide-state')).toHaveAttribute('data-state', 'ready');
  expect(await count()).toBe(1);
});

test('app puts Glide above Weather and preserves its controls on a narrow screen and reload', async ({ page, context }, testInfo) => {
  await airports(context);
  await page.addInitScript(() => {
    if (!localStorage.getItem('zlayers-map-view-v1')) localStorage.setItem('zlayers-map-view-v1', JSON.stringify({ version: 1, center: [-119.78, 34.43], zoom: 9 }));
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false');
  const glide = page.getByRole('button', { name: 'Show Glide Planner toolbox', exact: true });
  const weather = page.getByRole('button', { name: 'Show AWC Weather toolbox', exact: true });
  await expect(glide).toBeVisible();
  const glideBox = await glide.boundingBox(), weatherBox = await weather.boundingBox();
  expect(glideBox!.y + glideBox!.height).toBeLessThanOrEqual(weatherBox!.y + 1);
  const route = page.getByRole('textbox', { name: 'Add route waypoint', exact: true });
  await route.fill('KSBA KSMO'); await route.press('Enter');
  await page.getByLabel('Settings and offline downloads').click();
  await page.getByRole('tab', { name: 'Plugins', exact: true }).click();
  for (const id of ['navigation', 'terrain']) {
    const toggle = page.locator(`.plugin-row[data-plugin="${id}"]`).getByRole('switch');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
  }
  await page.getByLabel('Close settings').click();
  await glide.click();
  const panel = page.getByRole('region', { name: 'Glide Planner', exact: true });
  await panel.getByRole('spinbutton', { name: 'Glide ratio' }).fill('9.5');
  await panel.getByRole('spinbutton', { name: 'Glide ratio' }).press('Enter');
  await panel.getByRole('slider', { name: 'Glide start altitude' }).fill('8500');
  await panel.getByRole('switch', { name: 'Show airport coverage' }).click();
  await panel.getByRole('switch', { name: 'Show glide coverage' }).click();
  await expect(panel.getByRole('status', { name: 'Glide coverage status' })).toHaveText('2 airports within planning range');
  const bounds = await panel.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath('glide-phone.png') });
  await page.reload();
  await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false');
  await expect(panel.getByRole('spinbutton', { name: 'Glide ratio' })).toHaveValue('9.5');
  await expect(panel.getByRole('slider', { name: 'Glide start altitude' })).toHaveValue('8500');
  await expect(panel.getByRole('switch', { name: 'Show airport coverage' })).toHaveAttribute('aria-checked', 'true');
  await expect(panel.getByRole('switch', { name: 'Show glide coverage' })).toHaveAttribute('aria-checked', 'true');
});

test('obsolete terrain reads cannot revive disabled coverage and only one glide worker stays live', async ({ page, context }) => {
  await airports(context);
  await page.addInitScript(() => {
    const OriginalWorker = Worker;
    let count = 0;
    window.Worker = class extends OriginalWorker {
      tracked: boolean;
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args); this.tracked = String(args[0]).includes('glide.worker');
        if (this.tracked) document.documentElement.dataset.glideWorkers = String(++count);
      }
      override terminate() {
        if (this.tracked) { this.tracked = false; document.documentElement.dataset.glideWorkers = String(--count); }
        super.terminate();
      }
    };
  });
  let release!: () => void, requests = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await context.route('**/terrain/*/*/*.png', async route => {
    requests++; await gate;
    const match = /terrain\/(\d+)\/(\d+)\/(\d+)\.png/.exec(route.request().url())!;
    await route.fulfill({ contentType: 'image/png', body: terrainPng(Number(match[1]), Number(match[2]), Number(match[3]), () => 0) }).catch(() => {});
  });
  try {
    await page.goto('/test/browser/glide.html');
    await page.getByRole('switch', { name: 'Show airport coverage' }).click();
    expect(await page.evaluate(() => document.documentElement.dataset.glideWorkers ?? '0')).toBe('0');
    const toggle = page.getByRole('switch', { name: 'Show glide coverage' });
    await toggle.click();
    await expect.poll(() => requests).toBeGreaterThan(0);
    await page.getByRole('slider', { name: 'Glide start altitude' }).fill('9000');
    await page.getByRole('slider', { name: 'Glide start altitude' }).fill('7500');
    await expect(page.locator('html')).toHaveAttribute('data-glide-workers', '1');
    await toggle.click();
    await expect(page.locator('html')).toHaveAttribute('data-glide-workers', '0');
    release();
    await expect(page.getByTestId('glide-state')).toHaveAttribute('data-state', 'idle');
    const data = await page.evaluate(async () => window.glideAudit.map.getSource<GeoJSONSource>('glide-areas')!.getData()) as GeoJSON.FeatureCollection;
    expect(data.features).toEqual([]);
    await toggle.click();
    await expect(page.getByTestId('glide-state')).toHaveAttribute('data-state', 'ready');
    await expect(page.locator('html')).toHaveAttribute('data-glide-workers', '1');
    await page.evaluate(() => window.glideAudit.remount());
    await expect(page.getByTestId('glide-state')).toHaveAttribute('data-state', 'ready');
    await expect(page.locator('html')).toHaveAttribute('data-glide-workers', '1');
  } finally { release(); }
});

test('ownship ring stays distinct, reuses airport geometry, and responds to route/GPS/provider changes', async ({ page, context }, testInfo) => {
  await airports(context);
  await page.goto('/test/browser/glide.html');
  await page.getByRole('switch', { name: 'Show airport coverage' }).click();
  await page.getByRole('switch', { name: 'Show glide coverage' }).click();
  await expect(page.getByTestId('glide-state')).toHaveAttribute('data-state', 'ready');
  const count = (id: string) => page.evaluate(async id => {
    const data = await window.glideAudit.map.getSource<GeoJSONSource>(id)!.getData() as GeoJSON.FeatureCollection;
    return data.features.length;
  }, id);
  await page.evaluate(() => {
    const source = window.glideAudit.map.getSource<GeoJSONSource>('glide-areas')!, original = source.setData.bind(source);
    document.documentElement.dataset.airportPublishes = '0';
    source.setData = (...args: Parameters<typeof source.setData>) => {
      document.documentElement.dataset.airportPublishes = String(Number(document.documentElement.dataset.airportPublishes) + 1);
      return original(...args);
    };
    window.glideAudit.ownship([-119.78, 34.48]);
  });
  await expect.poll(() => count('glide-ownship')).toBe(1);
  await expect(page.getByLabel('Ownship glide status')).toContainText('live position, planning altitude');
  await page.evaluate(() => window.glideAudit.ownship([-119.77, 34.48]));
  await expect.poll(() => count('glide-ownship')).toBe(1);
  await expect(page.locator('html')).toHaveAttribute('data-airport-publishes', '0');
  expect(await count('glide-areas')).toBe(1);
  expect(await page.evaluate(() => window.glideAudit.map.getPaintProperty('glide-ownship-ring', 'line-dasharray'))).toBeUndefined();
  expect(await page.evaluate(() => window.glideAudit.map.getPaintProperty('glide-ownship-ring', 'line-color'))).toBe('#53e4c6');
  expect(await page.evaluate(() => window.glideAudit.map.getPaintProperty('glide-fill', 'fill-color'))).toBe('#ffc875');
  expect(await page.evaluate(() => window.glideAudit.map.getPaintProperty('glide-fill', 'fill-opacity'))).toBeGreaterThanOrEqual(.3);
  expect(await count('glide-ownship-area')).toBe(1);
  await page.screenshot({ path: testInfo.outputPath('glide-airports-and-ownship.png') });
  await page.evaluate(() => window.glideAudit.route(null));
  await expect(page.getByRole('status', { name: 'Glide coverage status' })).toContainText('Add a route');
  expect(await count('glide-areas')).toBe(0);
  expect(await count('glide-ownship')).toBe(1);
  await page.evaluate(() => window.glideAudit.ownship([-119.77, 34.48], 'stale'));
  await expect.poll(() => count('glide-ownship')).toBe(0);
  await expect(page.getByLabel('Ownship glide status')).toContainText('fresh GPS');
  await page.evaluate(() => window.glideAudit.ownship([-100, 34]));
  await expect(page.getByLabel('Ownship glide status')).toContainText('outside');
  expect(await count('glide-ownship')).toBe(0);
  await page.evaluate(() => window.glideAudit.ownship([-119.77, 34.48]));
  await expect.poll(() => count('glide-ownship')).toBe(1);
  await page.evaluate(() => window.glideAudit.provider('ownship', false));
  await expect.poll(() => count('glide-ownship')).toBe(0);
  await page.evaluate(() => window.glideAudit.provider('ownship', true));
  await expect.poll(() => count('glide-ownship')).toBe(1);
  await page.evaluate(() => window.glideAudit.route([[-120.1, 34.43], [-119.4, 34.43]]));
  await expect.poll(() => count('glide-areas')).toBe(1);
  await page.evaluate(() => window.glideAudit.provider('routes', false));
  await expect.poll(() => count('glide-areas')).toBe(0);
  await page.evaluate(() => window.glideAudit.provider('routes', true));
  await expect.poll(() => count('glide-areas')).toBe(1);
  await expect(page.getByTestId('errors')).toBeEmpty();
});

test('route edits filter cached airports and restore eligible offscreen origins without new terrain', async ({ page, context }) => {
  await airports(context);
  let terrainRequests = 0;
  page.on('request', request => { if (/\/terrain\/\d+\/\d+\/\d+\.png/.test(request.url())) terrainRequests++; });
  await page.goto('/test/browser/glide.html');
  await page.getByRole('switch', { name: 'Show airport coverage' }).click();
  await page.getByRole('switch', { name: 'Show glide coverage' }).click();
  await expect(page.getByTestId('glide-state')).toHaveAttribute('data-state', 'ready');
  const count = () => page.evaluate(async () => {
    const data = await window.glideAudit.map.getSource<GeoJSONSource>('glide-airports')!.getData() as GeoJSON.FeatureCollection;
    return data.features.length;
  });
  expect(await count()).toBe(2);
  const initialRequests = terrainRequests;
  await page.evaluate(() => window.glideAudit.route([[-120.1, 35], [-119.4, 35]]));
  await expect.poll(count).toBe(0);
  await expect(page.getByTestId('glide-state')).toHaveAttribute('data-state', 'ready');
  await page.evaluate(() => {
    window.glideAudit.route([[-120.1, 34.43], [-119.4, 34.43]]);
    window.glideAudit.map.jumpTo({ center: [-119.62, 34.43], zoom: 12, bearing: 45 });
  });
  await expect(page.getByTestId('glide-state')).toHaveAttribute('data-state', 'ready');
  await expect.poll(count).toBe(2);
  expect(terrainRequests).toBe(initialRequests);
  await page.evaluate(() => window.glideAudit.map.jumpTo({ center: [-119.78, 34.43], zoom: 9.2, bearing: 45 }));
  await expect.poll(count).toBe(2);
  await expect(page.getByTestId('errors')).toBeEmpty();
});

test('route-only edits replace airport coverage without blanking independent ranges, including at overview zoom', async ({ page, context }) => {
  await airports(context);
  await controlGlideResults(page);
  let terrainRequests = 0;
  page.on('request', request => { if (/\/terrain\/\d+\/\d+\/\d+\.png/.test(request.url())) terrainRequests++; });
  await page.goto('/test/browser/glide.html');
  await page.getByRole('switch', { name: 'Show airport coverage' }).click();
  await page.waitForFunction(() => !!window.glideAudit);
  await page.evaluate(() => window.glideAudit.ownship([-119.78, 34.43]));
  await page.mouse.click(640, 450, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Show glide range', exact: true }).click();
  const status = page.getByTestId('glide-state'), html = page.locator('html');
  await expect(status).toHaveAttribute('data-state', 'ready');
  const ids = ['glide-areas', 'glide-ownship', 'glide-ownship-area', 'glide-point-range', 'glide-point-area', 'glide-point'];
  const snapshot = () => page.evaluate(async ids => Promise.all(ids.map(id => window.glideAudit.map.getSource<GeoJSONSource>(id)!.getData())), ids);
  const initial = await snapshot(), initialRequests = terrainRequests;
  for (const data of initial) expect((data as GeoJSON.FeatureCollection).features.length).toBe(1);
  await page.evaluate(ids => {
    document.documentElement.dataset.glideRouteWrites = '[]';
    for (const id of ids) {
      const source = window.glideAudit.map.getSource<GeoJSONSource>(id)!, original = source.setData.bind(source);
      source.setData = (...args: Parameters<typeof source.setData>) => {
        const writes = JSON.parse(document.documentElement.dataset.glideRouteWrites!);
        writes.push([id, (args[0] as GeoJSON.FeatureCollection).features.length]);
        document.documentElement.dataset.glideRouteWrites = JSON.stringify(writes);
        return original(...args);
      };
    }
  }, ids);
  for (const zoom of [9.2, 5]) {
    await page.evaluate(zoom => window.glideAudit.map.jumpTo({ zoom }), zoom);
    await expect(status).toHaveAttribute('data-state', zoom < 7 ? 'zoom' : 'ready');
    await page.evaluate(zoom => {
      document.documentElement.dataset.holdGlideResults = 'true';
      const latitude = zoom < 7 ? 34.43 : 35.43;
      window.glideAudit.route([[-120.2, latitude], [zoom < 7 ? -119.2 : -119.3, latitude]]);
    }, zoom);
    await expect(html).toHaveAttribute('data-pending-glide-results', '1');
    expect(await snapshot()).toEqual(initial);
    // An obsolete empty corridor result must not erase the restored route.
    if (zoom >= 7) await page.evaluate(() => window.glideAudit.route([[-120.2, 34.43], [-119.3, 34.43]]));
    await page.evaluate(() => window.dispatchEvent(new Event('release-glide-results')));
    await expect(status).toHaveAttribute('data-state', zoom < 7 ? 'zoom' : 'ready');
    // Observe publication, not just the zoom status set before reconciliation.
    await expect.poll(() => page.evaluate(() => JSON.parse(document.documentElement.dataset.glideRouteWrites!).length)).toBe(zoom < 7 ? 2 : 1);
    expect((await snapshot()).slice(1)).toEqual(initial.slice(1));
    expect(terrainRequests).toBe(initialRequests);
  }
  const writes = await page.evaluate(() => JSON.parse(document.documentElement.dataset.glideRouteWrites!) as [string, number][]);
  expect(writes).toEqual([['glide-areas', 1], ['glide-areas', 1]]);
  await expect(page.getByLabel('Ownship glide status')).toContainText('live position');
  await expect(page.getByLabel('Selected point glide status')).toHaveText('Using the planning altitude below');
  // A real performance change still invalidates all ranges. At overview zoom,
  // the status must not describe an uncalculated new range as ready.
  await page.getByRole('slider', { name: 'Glide start altitude' }).fill('6000');
  await expect(page.getByLabel('Ownship glide status')).toHaveText('Zoom in to calculate ownship range');
  await expect(page.getByLabel('Selected point glide status')).toHaveText('Zoom in to calculate point range');
  expect((await snapshot()).map(data => (data as GeoJSON.FeatureCollection).features.length)).toEqual([0, 0, 0, 0, 0, 1]);
  expect(terrainRequests).toBe(initialRequests);
  await page.evaluate(() => window.glideAudit.map.jumpTo({ zoom: 9.2 }));
  await expect(status).toHaveAttribute('data-state', 'ready');
  for (const data of await snapshot()) expect((data as GeoJSON.FeatureCollection).features.length).toBe(1);
  await expect(page.getByTestId('errors')).toBeEmpty();
});

test('removing a route releases obsolete airport loading so a selected point can calculate immediately', async ({ page, context }) => {
  await airports(context);
  let release!: () => void, requested = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await context.route('**/nav/airports.geojson*', async route => { requested = true; await gate; await route.fallback(); });
  try {
    await page.goto('/test/browser/glide.html');
    await page.getByRole('switch', { name: 'Show airport coverage' }).click();
    await page.getByRole('switch', { name: 'Show glide coverage' }).click();
    await expect.poll(() => requested).toBe(true);
    await page.evaluate(() => window.glideAudit.route(null));
    await page.mouse.click(640, 450, { button: 'right' });
    await page.getByRole('menuitem', { name: 'Show glide range', exact: true }).click();
    await expect(page.getByLabel('Selected point glide status')).toHaveText('Using the planning altitude below');
    const snapshot = () => page.evaluate(async () => Promise.all(['glide-areas', 'glide-point-area'].map(async id =>
      (await window.glideAudit.map.getSource<GeoJSONSource>(id)!.getData() as GeoJSON.FeatureCollection).features.length)));
    expect(await snapshot()).toEqual([0, 1]);
    // The discarded consumer must not cancel shared navigation acquisition or
    // publish the old route when that acquisition eventually completes.
    const response = page.waitForResponse('**/nav/airports.geojson*');
    release(); await response;
    await expect(page.getByTestId('glide-state')).toHaveAttribute('data-state', 'ready');
    expect(await snapshot()).toEqual([0, 1]);
    await expect(page.getByTestId('errors')).toBeEmpty();
  } finally { release(); }
});

for (const during of ['movement', 'overview', 'discarded result'] as const) test(`offline terrain repair recovers cached gaps during ${during}`, async ({ page, context }) => {
  await airports(context);
  await context.route('**/terrain/*/*/*.png', route => route.fulfill({ status: 404 }));
  if (during === 'discarded result') await controlGlideResults(page);
  await page.goto('/test/browser/glide.html');
  await page.getByRole('switch', { name: 'Show airport coverage' }).click();
  if (during === 'discarded result') await page.evaluate(() => { document.documentElement.dataset.holdGlideResults = 'true'; });
  await page.getByRole('switch', { name: 'Show glide coverage' }).click();
  if (during === 'discarded result') {
    await expect(page.locator('html')).toHaveAttribute('data-pending-glide-results', '1');
    // Incomplete terrain is cached, but its response never reaches the view.
    // Drain the cancelled request before repairing the inventory.
    await page.evaluate(async () => {
      window.glideAudit.map.fire('movestart');
      window.dispatchEvent(new Event('release-glide-results'));
      await new Promise(requestAnimationFrame);
    });
    await expect(page.getByTestId('glide-state')).toHaveAttribute('data-state', 'loading');
  } else await expect(page.getByTestId('glide-state')).toHaveAttribute('data-state', 'partial');
  await context.unroute('**/terrain/*/*/*.png');
  await airports(context);
  await page.evaluate(during => {
    const map = window.glideAudit.map;
    if (during === 'overview') map.jumpTo({ zoom: 5 });
    else map.fire('movestart');
    window.dispatchEvent(new Event('zlayer-offline-inventory'));
    if (during === 'overview') map.jumpTo({ zoom: 9.2 });
    else map.fire('moveend');
  }, during);
  await expect(page.getByTestId('glide-state')).toHaveAttribute('data-state', 'ready');
  const data = await page.evaluate(() => window.glideAudit.map.getSource<GeoJSONSource>('glide-areas')!.getData()) as GeoJSON.FeatureCollection;
  expect(data.features.length).toBe(1);
  await expect(page.getByTestId('errors')).toBeEmpty();
});

test('panning retains completed ranges without republishing and rejects delayed results after disable', async ({ page, context }, testInfo) => {
  await airports(context);
  await controlGlideResults(page);
  await page.goto('/test/browser/glide.html');
  await page.getByRole('switch', { name: 'Show airport coverage' }).click();
  await page.waitForFunction(() => !!window.glideAudit);
  await page.evaluate(() => window.glideAudit.ownship([-119.78, 34.48]));
  await page.mouse.click(760, 440, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Show glide range', exact: true }).click();
  const status = page.getByTestId('glide-state'), html = page.locator('html');
  await expect(status).toHaveAttribute('data-state', 'ready');
  await expect(page.getByLabel('Selected point glide status')).toHaveText('Using the planning altitude below');
  const ids = ['glide-areas', 'glide-airports', 'glide-ownship', 'glide-ownship-area', 'glide-point-range', 'glide-point-area', 'glide-point'];
  const snapshot = () => page.evaluate(async ids => Promise.all(ids.map(async id =>
    await window.glideAudit.map.getSource<GeoJSONSource>(id)!.getData() as GeoJSON.FeatureCollection)), ids);
  const before = await snapshot();
  expect(before.map(data => data.features.length)).toEqual([1, 2, 1, 1, 1, 1, 1]);
  await page.evaluate(ids => {
    document.documentElement.dataset.glideWrites = '[]';
    document.documentElement.dataset.glideCalculations = '0';
    document.documentElement.dataset.holdGlideResults = 'true';
    for (const id of ids) {
      const source = window.glideAudit.map.getSource<GeoJSONSource>(id)!, original = source.setData.bind(source);
      source.setData = (...args: Parameters<typeof source.setData>) => {
        const writes = JSON.parse(document.documentElement.dataset.glideWrites!);
        writes.push([id, (args[0] as GeoJSON.FeatureCollection).features.length]);
        document.documentElement.dataset.glideWrites = JSON.stringify(writes);
        return original(...args);
      };
    }
  }, ids);
  const writes = () => page.evaluate(() => JSON.parse(document.documentElement.dataset.glideWrites!) as [string, number][]);
  const release = () => page.evaluate(() => { window.dispatchEvent(new Event('release-glide-results')); });
  await page.mouse.move(1100, 620); await page.mouse.down();
  await page.mouse.move(1020, 650, { steps: 8 });
  await expect.poll(() => page.evaluate(() => window.glideAudit.map.isMoving())).toBe(true);
  await expect(status).toHaveAttribute('data-state', 'loading');
  expect(await snapshot()).toEqual(before);
  await expect(html).toHaveAttribute('data-glide-calculations', '0');
  await page.mouse.up();
  await expect(html).toHaveAttribute('data-pending-glide-results', '1');
  expect(await snapshot()).toEqual(before);
  expect((await writes()).filter(([, count]) => count === 0)).toEqual([]);
  for (const layer of ['glide-outline', 'glide-ownship-ring', 'glide-point-ring']) {
    await expect.poll(() => page.evaluate(layer => window.glideAudit.map.queryRenderedFeatures({ layers: [layer] }).length, layer)).toBeGreaterThan(0);
  }
  await page.screenshot({ path: testInfo.outputPath('glide-pan-pending.png') });
  await release();
  await expect(status).toHaveAttribute('data-state', 'ready');
  expect((await snapshot()).map(data => data.features.length)).toEqual([1, 2, 1, 1, 1, 1, 1]);
  expect((await writes()).filter(([, count]) => count === 0)).toEqual([]);
  expect(await writes()).toEqual([]);

  // Hold a valid result, then move to an empty viewport before delivering it.
  await page.evaluate(() => {
    document.documentElement.dataset.holdGlideResults = 'true';
    window.glideAudit.map.jumpTo({ center: [-119.77, 34.44], zoom: 9.5, bearing: 30 });
  });
  await expect(html).toHaveAttribute('data-pending-glide-results', '1');
  await page.evaluate(() => {
    document.documentElement.dataset.glideWrites = '[]';
    window.glideAudit.map.jumpTo({ center: [-110, 34], zoom: 9.5 });
  });
  await release();
  await expect(status).toHaveAttribute('data-state', 'ready');
  expect((await snapshot()).map(data => data.features.length)).toEqual([1, 2, 1, 1, 1, 1, 1]);
  expect(await writes()).toEqual([]);
  await expect(page.getByLabel('Selected point glide status')).toHaveText('Point is outside the visible map');

  await page.evaluate(() => {
    document.documentElement.dataset.holdGlideResults = 'true';
    window.glideAudit.map.jumpTo({ center: [-119.78, 34.43], zoom: 9.2, bearing: 0 });
  });
  await expect(html).toHaveAttribute('data-pending-glide-results', '1');
  await page.getByRole('switch', { name: 'Show glide coverage' }).click();
  await release();
  await expect(status).toHaveAttribute('data-state', 'idle');
  expect((await snapshot()).map(data => data.features.length)).toEqual([0, 0, 0, 0, 0, 0, 0]);
  await expect(page.getByTestId('errors')).toBeEmpty();
});

test('zoom and route exploration retain cached airports and extend coverage only for newly visited origins', async ({ page, context }) => {
  await airports(context);
  await controlGlideResults(page);
  await context.route('**/nav/airports.geojson*', async route => {
    const response = await route.fetch(), body = await response.json();
    body.features.forEach((feature: { geometry: { coordinates: number[] }; properties: Record<string, unknown> }, i: number) => {
      feature.geometry.coordinates = [-119.78 + i * .8, 34.43];
      Object.assign(feature.properties, { elevationFt: 0, status: i === 2 ? 'C' : 'O', use: 'PR',
        runways: [{ id: '09/27', lengthFt: 1800, widthFt: 40, surface: 'TURF' }] });
    });
    await route.fulfill({ response, json: body });
  });
  let terrainRequests = 0;
  page.on('request', request => { if (/\/terrain\/\d+\/\d+\/\d+\.png/.test(request.url())) terrainRequests++; });
  await page.goto('/test/browser/glide.html');
  await page.getByRole('switch', { name: 'Show airport coverage' }).click();
  await page.waitForFunction(() => !!window.glideAudit);
  await page.evaluate(() => {
    window.glideAudit.route([[-120.1, 34.43], [-118.6, 34.43]]);
    window.glideAudit.map.jumpTo({ center: [-119.78, 34.43], zoom: 11 });
  });
  await page.getByRole('switch', { name: 'Show glide coverage' }).click();
  const status = page.getByTestId('glide-state');
  await expect(status).toHaveAttribute('data-state', 'ready');
  const snapshot = () => page.evaluate(async () => {
    const map = window.glideAudit.map;
    return { areas: await map.getSource<GeoJSONSource>('glide-areas')!.getData(),
      airports: (await map.getSource<GeoJSONSource>('glide-airports')!.getData() as GeoJSON.FeatureCollection).features.length };
  });
  const first = await snapshot(), initialRequests = terrainRequests;
  expect(first.airports).toBe(1); expect(initialRequests).toBeGreaterThan(0);
  for (const zoom of [13, 5, 11]) {
    await page.evaluate(zoom => window.glideAudit.map.jumpTo({ zoom, bearing: 35 }), zoom);
    await expect(status).toHaveAttribute('data-state', zoom < 7 ? 'zoom' : 'ready');
    expect(await snapshot()).toEqual(first); expect(terrainRequests).toBe(initialRequests);
  }
  await page.evaluate(() => {
    document.documentElement.dataset.holdGlideResults = 'true';
    window.glideAudit.map.jumpTo({ center: [-118.98, 34.43], zoom: 11, bearing: 0 });
  });
  await expect(page.locator('html')).toHaveAttribute('data-pending-glide-results', '1');
  expect((await snapshot()).airports).toBe(1);
  // The worker completed a new union, but its response belongs to an obsolete
  // camera generation. The following cached response must still publish it.
  await page.evaluate(() => {
    window.glideAudit.map.jumpTo({ center: [-119.78, 34.43], zoom: 11 });
    window.dispatchEvent(new Event('release-glide-results'));
  });
  await expect.poll(async () => (await snapshot()).airports).toBe(2);
  await expect(status).toHaveAttribute('data-state', 'ready');
  const extended = await snapshot(), afterExploring = terrainRequests;
  expect(afterExploring).toBeGreaterThan(initialRequests);
  await page.evaluate(() => window.glideAudit.map.jumpTo({ center: [-119.78, 34.43], zoom: 12 }));
  await expect(status).toHaveAttribute('data-state', 'ready');
  expect(await snapshot()).toEqual(extended); expect(terrainRequests).toBe(afterExploring);
  await page.getByRole('slider', { name: 'Glide start altitude' }).fill('4000');
  await expect.poll(async () => (await snapshot()).airports).toBe(1);
  await expect(status).toHaveAttribute('data-state', 'ready');
  expect((await snapshot()).areas).not.toEqual(extended.areas);
  await expect(page.getByTestId('errors')).toBeEmpty();
});

test('mountain coverage uses compact smooth contours for airports and ownship', async ({ page, context }, testInfo) => {
  await airports(context);
  await context.route('**/terrain/*/*/*.png', route => {
    const match = /terrain\/(\d+)\/(\d+)\/(\d+)\.png/.exec(route.request().url())!;
    const wx0 = (-119.8 + 180) / 360, wy0 = (1 - Math.asinh(Math.tan(34.43 * Math.PI / 180)) / Math.PI) / 2;
    return route.fulfill({ contentType: 'image/png', body: terrainPng(Number(match[1]), Number(match[2]), Number(match[3]), (wx: number, wy: number) => {
      const east = (wx - wx0) * 17850, north = (wy0 - wy) * 17850;
      const ridge = 1800 * Math.exp(-(((east - 4) / .85) ** 2)) * (.85 + .15 * Math.cos(north));
      const serrations = 150 * Math.sin(north * 30) * Math.exp(-(((east - 4) / 1.2) ** 2));
      return Math.max(0, ridge + serrations);
    }) });
  });
  await page.goto('/test/browser/glide.html');
  await page.getByRole('switch', { name: 'Show airport coverage' }).click();
  await page.getByRole('switch', { name: 'Show glide coverage' }).click();
  await expect(page.getByTestId('glide-state')).toHaveAttribute('data-state', 'ready');
  await page.evaluate(() => window.glideAudit.ownship([-119.8, 34.48]));
  await expect(page.getByLabel('Ownship glide status')).toContainText('live position');
  const result = await page.evaluate(async () => {
    const map = window.glideAudit.map;
    const areas = await map.getSource<GeoJSONSource>('glide-areas')!.getData() as GeoJSON.FeatureCollection<GeoJSON.MultiPolygon>;
    const ownship = await map.getSource<GeoJSONSource>('glide-ownship')!.getData() as GeoJSON.FeatureCollection<GeoJSON.MultiLineString>;
    const points = areas.features.flatMap(f => f.geometry.coordinates.flat(2));
    return { areaVertices: points.length, ownshipVertices: ownship.features.flatMap(f => f.geometry.coordinates.flat()).length,
      west: Math.min(...points.map(p => p[0]!)), east: Math.max(...points.map(p => p[0]!)) };
  });
  expect(result.areaVertices).toBeGreaterThan(12); expect(result.areaVertices).toBeLessThan(160);
  expect(result.ownshipVertices).toBeGreaterThan(12); expect(result.ownshipVertices).toBeLessThan(100);
  expect(-119.8 - result.west).toBeGreaterThan((result.east + 119.8) * 1.2);
  await page.screenshot({ path: testInfo.outputPath('glide-smoothed-mountains.png') });
  await testInfo.attach('mountain-geometry-counts', { body: JSON.stringify(result), contentType: 'application/json' });
  await expect(page.getByTestId('errors')).toBeEmpty();
});

test('a mountain valley produces long smooth lobes for airport, ownship and selected-point coverage', async ({ page, context }, testInfo) => {
  await airports(context);
  await context.route('**/nav/airports.geojson*', async route => {
    const response = await route.fetch(), body = await response.json();
    body.features.forEach((feature: { geometry: { coordinates: number[] }; properties: Record<string, unknown> }, i: number) => {
      feature.geometry.coordinates = [-119.78, 34.43];
      Object.assign(feature.properties, { elevationFt: 0, status: i === 0 ? 'O' : 'C', use: 'PR',
        runways: [{ id: '09/27', lengthFt: 1800, widthFt: 40, surface: 'TURF' }] });
    });
    await route.fulfill({ response, json: body });
  });
  await context.route('**/terrain/*/*/*.png', route => {
    const match = /terrain\/(\d+)\/(\d+)\/(\d+)\.png/.exec(route.request().url())!;
    const wx0 = (-119.78 + 180) / 360, wy0 = (1 - Math.asinh(Math.tan(34.43 * Math.PI / 180)) / Math.PI) / 2;
    const scale = 21600 * Math.cos(34.43 * Math.PI / 180), angle = 12 * Math.PI / 180;
    return route.fulfill({ contentType: 'image/png', body: terrainPng(Number(match[1]), Number(match[2]), Number(match[3]), (wx: number, wy: number) => {
      const x = (wx - wx0) * scale, y = (wy - wy0) * scale;
      const along = x * Math.cos(angle) + y * Math.sin(angle), across = -x * Math.sin(angle) + y * Math.cos(angle);
      return along > 2 && Math.abs(across) > .4 ? 9000 / 3.280839895 : 0;
    }) });
  });
  await page.goto('/test/browser/glide.html');
  await page.getByRole('switch', { name: 'Show airport coverage' }).click();
  await page.waitForFunction(() => !!window.glideAudit);
  await page.evaluate(() => window.glideAudit.ownship([-119.78, 34.43]));
  await page.mouse.click(640, 450, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Show glide range', exact: true }).click();
  await expect(page.getByTestId('glide-state')).toHaveAttribute('data-state', 'ready');
  await expect(page.getByLabel('Selected point glide status')).toHaveText('Using the planning altitude below');
  const metrics = await page.evaluate(async () => {
    const map = window.glideAudit.map, angle = 12 * Math.PI / 180;
    return Promise.all(['glide-areas', 'glide-ownship-area', 'glide-point-area'].map(async id => {
      const data = await map.getSource<GeoJSONSource>(id)!.getData() as GeoJSON.FeatureCollection<GeoJSON.MultiPolygon>;
      const points = data.features.flatMap(f => f.geometry.coordinates.flat(2));
      const along = points.map(p => {
        const x = (p[0]! + 119.78) * 60 * Math.cos(34.43 * Math.PI / 180), y = (34.43 - p[1]!) * 60;
        return x * Math.cos(angle) + y * Math.sin(angle);
      });
      return { id, reachNm: Math.max(...along), vertices: points.length };
    }));
  });
  for (const metric of metrics) {
    expect(metric.reachNm, metric.id).toBeGreaterThan(7.1);
    expect(metric.reachNm, metric.id).toBeLessThan(8.3);
    expect(metric.vertices, metric.id).toBeLessThan(100);
  }
  await page.screenshot({ path: testInfo.outputPath('glide-valley-lobes.png') });
  await testInfo.attach('valley-reach', { body: JSON.stringify(metrics), contentType: 'application/json' });
  await expect(page.getByTestId('errors')).toBeEmpty();
});

test('map menu enables point planning, replaces the pin and clears only its range', async ({ page, context }, testInfo) => {
  await airports(context);
  await page.goto('/test/browser/glide.html');
  await page.getByRole('switch', { name: 'Show airport coverage' }).click();
  await page.waitForFunction(() => !!window.glideAudit);
  const panel = page.getByRole('region', { name: 'Glide Planner', exact: true });
  const menu = page.getByRole('menu', { name: 'Map actions' });
  const count = (id: string) => page.evaluate(async id => {
    const data = await window.glideAudit.map.getSource<GeoJSONSource>(id)!.getData() as GeoJSON.FeatureCollection;
    return data.features.length;
  }, id);
  await page.evaluate(() => window.glideAudit.route(null));
  await page.getByRole('button', { name: 'Hide Glide Planner toolbox', exact: true }).click();
  await page.mouse.click(760, 440, { button: 'right' });
  await expect(menu).toBeVisible();
  expect(await count('glide-point')).toBe(0);
  await menu.getByRole('menuitem', { name: 'Show glide range', exact: true }).click();
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('switch', { name: 'Show glide coverage' })).toHaveAttribute('aria-checked', 'true');
  await expect(panel.getByRole('slider')).toBeFocused();
  await expect(page.getByLabel('Selected point glide status')).toHaveText('Using the planning altitude below');
  expect(await count('glide-areas')).toBe(0); expect(await count('glide-ownship')).toBe(0);
  expect(await count('glide-point-range')).toBe(1); expect(await count('glide-point-area')).toBe(1);
  const coordinates = () => page.evaluate(async () => {
    const data = await window.glideAudit.map.getSource<GeoJSONSource>('glide-point')!.getData() as GeoJSON.FeatureCollection<GeoJSON.Point>;
    return data.features.map(f => f.geometry.coordinates);
  });
  const first = await coordinates();
  const expected = await page.evaluate(() => window.glideAudit.map.unproject([760, 440]).toArray());
  expect(first[0]![0]).toBeCloseTo(expected[0], 7); expect(first[0]![1]).toBeCloseTo(expected[1], 7);
  expect(await page.evaluate(() => window.glideAudit.map.getPaintProperty('glide-point-ring', 'line-dasharray'))).toEqual([4, 2]);
  await page.evaluate(() => {
    window.glideAudit.route([[-120.1, 34.43], [-119.4, 34.43]]);
    window.glideAudit.ownship([-119.78, 34.48]);
  });
  await expect.poll(() => count('glide-areas')).toBe(1);
  await expect.poll(() => count('glide-ownship')).toBe(1);
  await page.evaluate(() => {
    const source = window.glideAudit.map.getSource<GeoJSONSource>('glide-areas')!, original = source.setData.bind(source);
    document.documentElement.dataset.airportPublishes = '0';
    source.setData = (...args: Parameters<typeof source.setData>) => {
      document.documentElement.dataset.airportPublishes = String(Number(document.documentElement.dataset.airportPublishes) + 1);
      return original(...args);
    };
  });
  await page.mouse.click(800, 470, { button: 'right' });
  await menu.getByRole('menuitem', { name: 'Show glide range', exact: true }).click();
  await expect(page.getByLabel('Selected point glide status')).toHaveText('Using the planning altitude below');
  expect(await coordinates()).not.toEqual(first); expect((await coordinates()).length).toBe(1);
  await expect(page.locator('html')).toHaveAttribute('data-airport-publishes', '0');
  await page.screenshot({ path: testInfo.outputPath('glide-point-and-ownship.png') });
  await page.evaluate(() => window.glideAudit.remount());
  await expect.poll(() => count('glide-point-range')).toBe(1);
  await panel.getByRole('button', { name: 'Clear selected glide point', exact: true }).click();
  for (const id of ['glide-point', 'glide-point-range', 'glide-point-area']) await expect.poll(() => count(id)).toBe(0);
  expect(await count('glide-ownship')).toBe(1); expect(await count('glide-areas')).toBe(1);
  await expect(page.getByLabel('Selected glide point coordinates')).toHaveCount(0);
  await expect(page.getByTestId('errors')).toBeEmpty();
});

test('clearing a point while terrain loads cannot restore its pin or range', async ({ page, context }) => {
  await airports(context);
  let release!: () => void, requests = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await context.route('**/terrain/*/*/*.png', async route => {
    requests++; await gate;
    const match = /terrain\/(\d+)\/(\d+)\/(\d+)\.png/.exec(route.request().url())!;
    await route.fulfill({ contentType: 'image/png', body: terrainPng(Number(match[1]), Number(match[2]), Number(match[3]), () => 0) }).catch(() => {});
  });
  try {
    await page.goto('/test/browser/glide.html');
    await page.getByRole('switch', { name: 'Show airport coverage' }).click();
    await page.waitForFunction(() => !!window.glideAudit);
    await page.mouse.click(760, 440, { button: 'right' });
    await page.getByRole('menuitem', { name: 'Show glide range', exact: true }).click();
    await expect.poll(() => requests).toBeGreaterThan(0);
    await page.mouse.click(800, 470, { button: 'right' });
    await page.getByRole('menuitem', { name: 'Clear selected glide point', exact: true }).click();
    release();
    await expect(page.getByTestId('glide-state')).toHaveAttribute('data-state', 'ready');
    const sources = await page.evaluate(async () => Promise.all(['glide-point', 'glide-point-range', 'glide-point-area', 'glide-areas'].map(async id => {
      const data = await window.glideAudit.map.getSource<GeoJSONSource>(id)!.getData() as GeoJSON.FeatureCollection;
      return data.features.length;
    })));
    expect(sources).toEqual([0, 0, 0, 1]);
    await expect(page.getByLabel('Selected glide point coordinates')).toHaveCount(0);
    await expect(page.getByTestId('errors')).toBeEmpty();
  } finally { release(); }
});

test.describe('touch point planning', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'Physical long-press injection uses Chromium CDP.');
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test('long press opens Glide without route/GPS and point selection is session-only', async ({ page, context }, testInfo) => {
    await airports(context);
    await page.addInitScript(() => {
      if (!localStorage.getItem('zlayers-map-view-v1')) localStorage.setItem('zlayers-map-view-v1', JSON.stringify({ version: 1, center: [-119.78, 34.43], zoom: 9 }));
    });
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto('/');
    await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false');
    const menu = page.getByRole('menu', { name: 'Map actions' });
    const canvas = (await page.locator('.maplibregl-canvas').boundingBox())!;
    const point = { x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2 };
    const session = await context.newCDPSession(page);
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await expect(menu).toBeVisible();
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await session.detach();
    await expect(menu.getByRole('menuitem', { name: 'Show glide range', exact: true })).toBeVisible();
    await expect(page.getByLabel('Selected glide point coordinates')).toHaveCount(0);
    await menu.getByRole('menuitem', { name: 'Show glide range', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Glide Planner', exact: true });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('switch', { name: 'Show glide coverage' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByLabel('Selected point glide status')).toHaveText('Using the planning altitude below');
    await expect(panel.getByRole('slider')).toHaveValue('6500');
    const bounds = (await panel.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: testInfo.outputPath('glide-point-phone.png') });
    await page.reload();
    await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByLabel('Selected glide point coordinates')).toHaveCount(0);
    await expect(panel.getByRole('switch', { name: 'Show glide coverage' })).toHaveAttribute('aria-checked', 'true');
    await page.getByLabel('Settings and offline downloads').click();
    await page.getByRole('tab', { name: 'Plugins', exact: true }).click();
    for (const id of ['glide', 'routes']) {
      const toggle = page.locator(`.plugin-row[data-plugin="${id}"]`).getByRole('switch');
      await toggle.click(); await expect(toggle).toHaveAttribute('aria-checked', 'false');
    }
    await page.getByLabel('Close settings').click();
    await page.mouse.click(point.x, point.y, { button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Show glide range', exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});


test('GPS loss while a result is pending cannot restore its ring or ready status', async ({ page, context }) => {
  await airports(context);
  await controlGlideResults(page);
  await page.goto('/test/browser/glide.html');
  await page.getByRole('switch', { name: 'Show airport coverage' }).click();
  await page.waitForFunction(() => !!window.glideAudit);
  await page.evaluate(() => window.glideAudit.ownship([-119.78, 34.43]));
  await page.getByRole('switch', { name: 'Show glide coverage' }).click();
  await expect(page.getByLabel('Ownship glide status')).toContainText('live position');
  await page.evaluate(() => {
    document.documentElement.dataset.holdGlideResults = 'true';
    window.glideAudit.ownship([-119.77, 34.43]);
  });
  await expect(page.locator('html')).toHaveAttribute('data-pending-glide-results', '1');
  await page.evaluate(() => {
    window.glideAudit.ownship(null, 'stale');
    const output = document.querySelector('[data-testid="glide-state"]')!;
    new MutationObserver(() => {
      if (JSON.parse(output.textContent!).ownship === 'ready') document.documentElement.dataset.staleOwnshipStatus = 'true';
    }).observe(output, { childList: true, characterData: true, subtree: true });
  });
  await expect(page.getByLabel('Ownship glide status')).toHaveText('Ownship ring needs a fresh GPS position');
  await page.evaluate(() => window.dispatchEvent(new Event('release-glide-results')));
  await expect(page.locator('html')).toHaveAttribute('data-glide-calculations', '3');
  await expect(page.getByTestId('glide-state')).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('html')).not.toHaveAttribute('data-stale-ownship-status', 'true');
  for (const id of ['glide-ownship', 'glide-ownship-area']) {
    expect(await page.evaluate(async id => (await window.glideAudit.map.getSource<GeoJSONSource>(id)!.getData() as GeoJSON.FeatureCollection).features.length, id)).toBe(0);
  }
  await expect(page.getByTestId('errors')).toBeEmpty();
});

test('GPS drift does no glide work and nearby moving rings replace without blanking during track-up follow', async ({ page, context }) => {
  await airports(context);
  await controlGlideResults(page);
  await page.clock.install();
  await page.goto('/test/browser/glide.html');
  await page.getByRole('switch', { name: 'Show airport coverage' }).click();
  await page.waitForFunction(() => !!window.glideAudit);
  await page.evaluate(() => window.glideAudit.ownship([-119.78, 34.43]));
  await page.getByRole('switch', { name: 'Show glide coverage' }).click();
  await expect(page.getByLabel('Ownship glide status')).toContainText('live position');
  await page.evaluate(() => {
    document.documentElement.dataset.rangeUploads = '0';
    document.documentElement.dataset.rangeBlanks = '0';
    document.documentElement.dataset.glideCalculations = '0';
    document.documentElement.dataset.glideCancellations = '0';
    document.documentElement.dataset.rangeEdges = '[]';
    for (const id of ['glide-ownship', 'glide-ownship-area']) {
      const source = window.glideAudit.map.getSource<GeoJSONSource>(id)!, original = source.setData.bind(source);
      source.setData = (...args: Parameters<typeof source.setData>) => {
        const data = args[0] as GeoJSON.FeatureCollection;
        const key = data.features.length ? 'rangeUploads' : 'rangeBlanks';
        document.documentElement.dataset[key] = String(Number(document.documentElement.dataset[key]) + 1);
        if (id === 'glide-ownship' && data.features.length) {
          const lines = data as GeoJSON.FeatureCollection<GeoJSON.MultiLineString>;
          const east = Math.max(...lines.features.flatMap(feature => feature.geometry.coordinates.flat().map(point => point[0]!)));
          const edges = JSON.parse(document.documentElement.dataset.rangeEdges!) as number[];
          edges.push(east); document.documentElement.dataset.rangeEdges = JSON.stringify(edges);
        }
        return original(...args);
      };
    }
  });
  for (const offset of [0, .00003, -.00003, .00008, -.00008, 0]) {
    await page.evaluate(offset => window.glideAudit.ownship([-119.78 + offset, 34.43]), offset);
    await page.clock.runFor(1000);
  }
  await expect(page.locator('html')).toHaveAttribute('data-glide-calculations', '0');
  await expect(page.locator('html')).toHaveAttribute('data-range-uploads', '0');
  await expect(page.locator('html')).toHaveAttribute('data-range-blanks', '0');
  await page.evaluate(() => {
    document.documentElement.dataset.holdGlideResults = 'true';
    window.glideAudit.ownship([-119.7794, 34.43]); // about 55 m of real movement
  });
  await expect(page.locator('html')).toHaveAttribute('data-pending-glide-results', '1');
  await page.evaluate(() => window.glideAudit.map.easeTo({ center: [-119.7794, 34.43], bearing: 45, duration: 250 }, { gpsCamera: true }));
  await page.clock.runFor(300);
  await expect(page.locator('html')).toHaveAttribute('data-range-blanks', '0');
  await expect(page.locator('html')).toHaveAttribute('data-glide-cancellations', '0');
  await page.evaluate(() => window.dispatchEvent(new Event('release-glide-results')));
  await expect(page.getByLabel('Ownship glide status')).toContainText('live position');
  await expect.poll(() => page.evaluate(() => new Set(JSON.parse(document.documentElement.dataset.rangeEdges!) as number[]).size)).toBeGreaterThan(3);
  await page.clock.runFor(1000);
  await expect.poll(() => page.evaluate(() => (JSON.parse(document.documentElement.dataset.rangeEdges!) as number[]).at(-1)
    === Number(document.documentElement.dataset.rangeTargetEast))).toBe(true);
  const uploads = await page.evaluate(() => Number(document.documentElement.dataset.rangeUploads));
  expect(uploads).toBeGreaterThan(6); expect(uploads).toBeLessThanOrEqual(42);
  await page.clock.runFor(1000);
  await expect(page.locator('html')).toHaveAttribute('data-range-uploads', String(uploads));
  await expect(page.locator('html')).toHaveAttribute('data-range-blanks', '0');
  // Retention is bounded by distance from the published origin, not each fix.
  await page.evaluate(() => {
    document.documentElement.dataset.holdGlideResults = 'true';
    window.glideAudit.ownship([-119.77, 34.43]);
  });
  await expect(page.locator('html')).toHaveAttribute('data-range-blanks', '2');
  await page.getByRole('switch', { name: 'Show glide coverage' }).click();
  await page.evaluate(() => {
    document.documentElement.dataset.rangeBlanks = '0';
    document.documentElement.dataset.glideCalculations = '0';
    for (let i = 0; i < 20; i++) window.glideAudit.ownship([-119.77 + i * .001, 34.43]);
  });
  await page.clock.runFor(1000);
  await expect(page.locator('html')).toHaveAttribute('data-range-blanks', '0');
  await expect(page.locator('html')).toHaveAttribute('data-glide-calculations', '0');
  await expect(page.getByTestId('errors')).toBeEmpty();
});

test('a calculated empty forward range is retained without repeated source updates', async ({ page, context }) => {
  await airports(context);
  await page.goto('/test/browser/glide.html');
  await page.getByRole('switch', { name: 'Show airport coverage' }).click();
  await page.waitForFunction(() => !!window.glideAudit);
  await page.evaluate(() => window.glideAudit.ownship([-119.78, 34.43]));
  await page.getByRole('slider').fill('0');
  await page.getByRole('switch', { name: 'Show glide coverage' }).click();
  await expect(page.getByTestId('glide-state')).toHaveAttribute('data-state', 'ready');
  await page.evaluate(async () => {
    const source = window.glideAudit.map.getSource<GeoJSONSource>('glide-ownship-area')!;
    if ((await source.getData() as GeoJSON.FeatureCollection).features.length) throw new Error('Expected empty range');
    const original = source.setData.bind(source);
    document.documentElement.dataset.forwardPublishes = '0';
    source.setData = (...args: Parameters<typeof source.setData>) => {
      document.documentElement.dataset.forwardPublishes = String(Number(document.documentElement.dataset.forwardPublishes) + 1);
      return original(...args);
    };
  });
  for (const lng of [-119.8, -119.76]) {
    await page.evaluate(lng => window.glideAudit.map.jumpTo({ center: [lng, 34.43] }), lng);
    await expect(page.getByTestId('glide-state')).toHaveAttribute('data-state', 'ready');
    await expect(page.locator('html')).toHaveAttribute('data-forward-publishes', '0');
  }
  await expect(page.getByTestId('errors')).toBeEmpty();
});
