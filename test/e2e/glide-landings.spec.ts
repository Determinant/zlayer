import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { terrainPng } from './terrain-fixture.mjs';
import type { GeoJSONSource } from 'maplibre-gl';
import { heatPixels } from './glide-heat';

function fixture(elevationM = 50) {
  const ring = (west: number, south: number, east: number, north: number) => {
    let x = 0, y = 0;
    return [[west, south], [east, south], [east, north], [west, north]].flatMap(([lon, lat]) => {
      const nx = Math.round(lon! * 1e6), ny = Math.round(lat! * 1e6), delta = [nx - x, ny - y];
      x = nx; y = ny; return delta;
    });
  };
  const fit = (tier: number) => [-119850000, 34420000, -119800000, 34420000, 200, tier === 2 ? 3000 : 1500, elevationM, tier];
  const records = [
    [fit(2), [ring(-119.86, 34.40, -119.79, 34.46), ring(-119.838, 34.424, -119.826, 34.436)], 1],
    [fit(2), [ring(-119.79, 34.40, -119.74, 34.46)], 0],
    [fit(1), [ring(-119.73, 34.40, -119.70, 34.43)], 0],
  ];
  const raw = JSON.stringify(records) + '\n', bytes = gzipSync(raw), sha256 = createHash('sha256').update(bytes).digest('hex');
  return { bytes, manifest: { schemaVersion: 4, builderVersion: 9, status: 'experimental-candidates',
    geometryMeaning: 'generalized-candidate-area', generatedAt: '2026-10-02T00:00:00Z', inputSha256: 'a'.repeat(64),
    coverage: [{ id: 'sample', bounds: [-121, 33, -118, 36] }],
    shards: [{ id: '-120-34', file: `${sha256}.glide.gz`, sha256, bytes: bytes.length, rawBytes: Buffer.byteLength(raw),
      bounds: [-119.86, 34.40, -119.70, 34.46], count: 3, tiers: [1, 2] }] } };
}
async function serve(context: BrowserContext, available: () => boolean = () => true) {
  const data = fixture(); let reads = 0;
  await context.route('**/terrain/*/*/*.png', route => {
    const match = /terrain\/(\d+)\/(\d+)\/(\d+)\.png/.exec(route.request().url())!;
    return route.fulfill({ contentType: 'image/png', body: terrainPng(Number(match[1]), Number(match[2]), Number(match[3]), () => 0) });
  });
  await context.route('**/glide/manifest.json', route => available()
    ? route.fulfill({ json: data.manifest }) : route.fulfill({ status: 404 }));
  await context.route('**/glide/*.glide.gz', route => {
    reads++; return route.fulfill({ contentType: 'application/gzip', body: data.bytes });
  });
  return () => reads;
}

async function selectRange(page: Page) {
  const pixel = await page.evaluate(() => { const p = window.glideAudit.map.project([-119.81, 34.42]); return { x: p.x, y: p.y }; });
  await page.mouse.click(pixel.x, pixel.y, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Show glide range', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Landing areas status' })).toHaveText('2 candidate patches loaded');
}

async function inspectArea(page: Page) {
  await expect.poll(() => page.evaluate(() => window.glideAudit.map.queryRenderedFeatures({ layers: ['glide-landing-fill'] }).length)).toBeGreaterThan(0);
  const pixel = await page.evaluate(() => { const p = window.glideAudit.map.project([-119.81, 34.42]); return { x: p.x, y: p.y }; });
  await page.mouse.click(pixel.x, pixel.y, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Inspect landing area', exact: true }).click();
  await expect(page.getByLabel('Selected point glide status')).toContainText('NM of route inside arrival range');
}

test('route density uses cached shading; selected-range details retain tiers and holes independently of the route', async ({ page, context }, testInfo) => {
  const reads = await serve(context);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/test/browser/glide.html');
  await page.waitForFunction(() => !!window.glideAudit);
  const toggle = page.getByRole('switch', { name: 'Show off-field coverage' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await page.getByRole('switch', { name: 'Show glide coverage' }).click();
  expect(reads()).toBe(0);
  await toggle.click();
  const status = page.getByRole('status', { name: 'Landing areas status' });
  await expect(status).toHaveText('Landing-area density along your route');
  const data = () => page.evaluate(async () => await window.glideAudit.map.getSource<GeoJSONSource>('glide-landing-areas')!.getData() as GeoJSON.FeatureCollection<GeoJSON.MultiPolygon>);
  expect((await data()).features).toEqual([]);
  await expect.poll(() => heatPixels(page)).toBeGreaterThan(0);
  expect(reads()).toBe(1);
  const assumptions = page.getByText('Planning assumptions', { exact: true });
  const surfaceCaveat = page.getByText('Includes cultivated fields. Current crops, vegetation and ground conditions are unverified.', { exact: false });
  await expect(surfaceCaveat).toBeHidden();
  await assumptions.click();
  await expect(surfaceCaveat).toBeVisible();
  await expect(page.getByText('Screened candidates, not verified landing sites.', { exact: false })).toBeVisible();
  await expect(page.getByText('Unmarked ground may be unassessed or fail screening.', { exact: false })).toBeVisible();
  await assumptions.click();
  await expect(surfaceCaveat).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('glide-landing-density.png') });
  await page.evaluate(() => window.glideAudit.map.jumpTo({ center: [-119.80, 34.43], zoom: 9.5 }));
  await expect(status).toHaveText('Landing-area density along your route');
  expect(reads()).toBe(1);
  await expect.poll(() => heatPixels(page)).toBeGreaterThan(0);
  await page.evaluate(() => window.glideAudit.map.jumpTo({ center: [-119.832, 34.43], zoom: 12 }));
  await expect.poll(() => heatPixels(page, [-119.81, 34.42])).toBe(1);
  expect(await heatPixels(page, [-119.832, 34.43])).toBe(0);
  expect(reads()).toBe(1);
  await page.evaluate(() => window.glideAudit.map.jumpTo({ center: [-119.80, 34.43], zoom: 9.5 }));
  await selectRange(page);
  const initial = await data();
  expect(initial.features.map(feature => feature.properties!.tier)).toEqual([1, 2]);
  expect(initial.features[1]!.geometry.coordinates[0]!.length).toBe(2);
  await expect.poll(() => page.evaluate(() => window.glideAudit.map.queryRenderedFeatures({ layers: ['glide-landing-fill'] }).length)).toBeGreaterThan(0);
  expect(reads(), 'detail reuses the already downloaded source file').toBe(1);
  await page.screenshot({ path: testInfo.outputPath('glide-landing-details.png') });
  await page.evaluate(() => window.glideAudit.route(null));
  await expect(status).toHaveText('2 candidate patches loaded');
  expect(await data()).toEqual(initial);
  await page.getByRole('button', { name: 'Clear selected glide point' }).click();
  await expect(status).toHaveText('Add a route or show a glide range to see landing candidates');
  await expect.poll(async () => (await data()).features.length).toBe(0);
  await page.evaluate(() => window.glideAudit.route([[-120.1, 34.43], [-119.4, 34.43]]));
  await expect(status).toHaveText('Landing-area density along your route');
  expect(reads(), 'restored route reuses derived summary cache').toBe(1);
  await toggle.click();
  await expect.poll(async () => (await data()).features.length).toBe(0);
  await page.reload(); await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('errors')).toBeEmpty(); expect(errors).toEqual([]);
});

test('pans, off-screen visits and zoom changes retain geographic heat tiles through the real worker', async ({ page, context }) => {
  const reads = await serve(context);
  await page.addInitScript(() => {
    const NativeWorker = Worker;
    window.Worker = class extends NativeWorker {
      readonly queries = new Set<string>();
      readonly landing: boolean;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options); this.landing = String(url).includes('landing.worker');
        this.addEventListener('message', event => {
          if (this.queries.delete(event.data.id)) {
            document.documentElement.dataset.heatReplies = String(Number(document.documentElement.dataset.heatReplies ?? 0) + 1);
            if (event.data.value?.heat !== undefined) document.documentElement.dataset.heatUploads =
              String(Number(document.documentElement.dataset.heatUploads ?? 0) + 1);
          }
        });
      }
      override postMessage(message: unknown, options: Transferable[] | StructuredSerializeOptions = []) {
        const rpc = message as { path?: string[]; id: string };
        if (this.landing && rpc.path?.[0] === 'query') this.queries.add(rpc.id);
        if (Array.isArray(options)) super.postMessage(message, options); else super.postMessage(message, options);
      }
    };
  });
  await page.goto('/test/browser/glide.html');
  await page.getByRole('switch', { name: 'Show glide coverage' }).click();
  await page.getByRole('switch', { name: 'Show off-field coverage' }).click();
  await expect(page.getByRole('status', { name: 'Landing areas status' })).toHaveText('Landing-area density along your route');
  const center = await page.evaluate(() => {
    document.documentElement.dataset.heatUploads = '0';
    return window.glideAudit.map.getCenter().toArray();
  });
  for (const [dx, zoom] of [[.0005, 9], [20, 9], [0, 6], [0, 12], [0, 9]] as [number, number][]) {
    const replies = Number(await page.locator('html').getAttribute('data-heat-replies'));
    await page.evaluate(({ center, dx, zoom }) => window.glideAudit.map.jumpTo({ center: [center[0]! + dx, center[1]!], zoom }), { center, dx, zoom });
    await expect.poll(async () => Number(await page.locator('html').getAttribute('data-heat-replies'))).toBeGreaterThan(replies);
    await expect(page.locator('html')).toHaveAttribute('data-heat-uploads', '0');
  }
  await expect.poll(() => heatPixels(page)).toBeGreaterThan(0);
  expect(reads()).toBe(1);
  await expect(page.getByTestId('errors')).toBeEmpty();
});

test('a failed unsettled landing upload recovers and subsequent heat edits render without a zoom', async ({ page, context }) => {
  const reads = await serve(context);
  await page.goto('/test/browser/glide.html');
  await page.getByRole('switch', { name: 'Show glide coverage' }).click();
  await page.getByRole('switch', { name: 'Show off-field coverage' }).click();
  const status = page.getByRole('status', { name: 'Landing areas status' });
  await expect(status).toHaveText('Landing-area density along your route');
  const camera = await page.evaluate(() => {
    const map = window.glideAudit.map, source = map.getSource<GeoJSONSource>('glide-landing-areas')!;
    const original = source.setData.bind(source);
    source.setData = data => {
      if ((data as GeoJSON.FeatureCollection).features.length) {
        source.setData = original;
        queueMicrotask(() => map.fire('error', { sourceId: source.id, error: new Error('Injected unsettled landing upload') }));
        return new Promise<void>(() => {});
      }
      return original(data);
    };
    return { zoom: map.getZoom(), center: map.getCenter().toArray() };
  });
  await selectRange(page);
  await expect(page.getByTestId('errors')).toHaveText('Injected unsettled landing upload');
  // Recovery must release the display job, not just restore the old collection.
  await page.evaluate(() => window.glideAudit.route([[-120.1, 34.44], [-119.4, 34.44]]));
  await expect.poll(() => heatPixels(page)).toBeGreaterThan(0);
  await expect(status).toHaveText('2 candidate patches loaded');
  expect(await page.evaluate(() => ({ zoom: window.glideAudit.map.getZoom(), center: window.glideAudit.map.getCenter().toArray() }))).toEqual(camera);
  expect(reads()).toBe(1);
});

test('ownship details work without a route and disappear on GPS loss', async ({ page, context }) => {
  await serve(context);
  await page.goto('/test/browser/glide.html');
  await page.waitForFunction(() => !!window.glideAudit);
  await page.evaluate(() => { window.glideAudit.route(null); window.glideAudit.ownship([-119.81, 34.42]); });
  await page.getByRole('switch', { name: 'Show glide coverage' }).click();
  await page.getByRole('switch', { name: 'Show off-field coverage' }).click();
  await expect(page.getByRole('status', { name: 'Landing areas status' })).toHaveText('2 candidate patches loaded');
  await page.evaluate(() => window.glideAudit.ownship(null, 'stale'));
  await expect(page.getByRole('status', { name: 'Landing areas status' })).toHaveText('Add a route or show a glide range to see landing candidates');
  await expect.poll(() => page.evaluate(async () => (await window.glideAudit.map.getSource<GeoJSONSource>('glide-landing-areas')!.getData() as GeoJSON.FeatureCollection).features.length)).toBe(0);
  await expect(page.getByTestId('errors')).toBeEmpty();
});

for (const routeVisible of [false, true]) test(`moving ownship preserves a pending landing download ${routeVisible ? 'with route shading' : 'without a route'}`, async ({ page, context }) => {
  await serve(context);
  let reads = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await context.route('**/glide/*.glide.gz', async route => { reads++; await gate; await route.fallback(); });
  await page.addInitScript(() => {
    const NativeWorker = Worker;
    window.Worker = class extends NativeWorker {
      readonly landing: boolean;
      constructor(url: string | URL, options?: WorkerOptions) { super(url, options); this.landing = String(url).includes('landing.worker'); }
      override postMessage(message: unknown, options: Transferable[] | StructuredSerializeOptions = []) {
        if (this.landing && (message as { path?: string[] }).path?.[0] === 'cancel') {
          document.documentElement.dataset.landingCancellations = String(Number(document.documentElement.dataset.landingCancellations ?? 0) + 1);
        }
        if (Array.isArray(options)) super.postMessage(message, options); else super.postMessage(message, options);
      }
    };
  });
  try {
    await page.goto('/test/browser/glide.html');
    await page.waitForFunction(() => !!window.glideAudit);
    await page.evaluate(routeVisible => {
      if (!routeVisible) window.glideAudit.route(null);
      window.glideAudit.ownship([-119.81, 34.42]);
    }, routeVisible);
    await page.getByRole('switch', { name: 'Show glide coverage' }).click();
    await expect(page.getByLabel('Ownship glide status')).toContainText('live position');
    await page.getByRole('switch', { name: 'Show off-field coverage' }).click();
    await expect.poll(() => reads).toBe(1);
    await page.evaluate(() => { document.documentElement.dataset.landingCancellations = '0'; });
    for (const longitude of [-119.8094, -119.8088, -119.8082]) {
      await page.evaluate(longitude => {
        window.glideAudit.ownship([longitude, 34.42]);
        window.glideAudit.map.jumpTo({ center: [longitude, 34.42] }, { gpsCamera: true });
      }, longitude);
      await expect(page.getByLabel('Ownship glide status')).toContainText('live position');
    }
    await expect(page.locator('html')).toHaveAttribute('data-landing-cancellations', '0');
    expect(reads).toBe(1);
    release();
    await expect(page.getByRole('status', { name: 'Landing areas status' })).toHaveText('2 candidate patches loaded');
    expect(reads, 'new ranges reuse the completed download').toBe(1);
    await expect(page.getByTestId('errors')).toBeEmpty();
  } finally { release(); }
});

test('unpublished landing data is independent of glide ranges and retry discovers the completed feed', async ({ page, context }) => {
  let published = false;
  await serve(context, () => published);
  await page.goto('/test/browser/glide.html');
  await page.getByRole('switch', { name: 'Show glide coverage' }).click();
  await page.getByRole('switch', { name: 'Show off-field coverage' }).click();
  await expect(page.getByRole('status', { name: 'Landing areas status' })).toHaveText('Landing-area data has not been published yet');
  await expect(page.getByRole('status', { name: 'Glide coverage status' })).toHaveText('Airport coverage is off');
  published = true;
  await page.getByRole('button', { name: 'Retry landing areas' }).click();
  await expect(page.getByRole('status', { name: 'Landing areas status' })).toHaveText('Landing-area density along your route');
  await expect(page.getByTestId('errors')).toBeEmpty();
});


test('inspect landing area keeps individual flags and calculates a purple arrival range', async ({ page, context }, testInfo) => {
  await serve(context);
  await page.goto('/test/browser/glide.html');
  await page.getByRole('switch', { name: 'Show glide coverage' }).click();
  await page.getByRole('switch', { name: 'Show off-field coverage' }).click();
  await expect(page.getByRole('status', { name: 'Landing areas status' })).toHaveText('Landing-area density along your route');
  await selectRange(page);
  await inspectArea(page);
  const card = page.getByLabel('Selected glide point', { exact: true });
  await expect(card.getByText('Glide to selected area', { exact: true })).toBeVisible();
  await expect(card.getByText('Preferred · 3,000 × 200 ft fit', { exact: true })).toBeVisible();
  await expect(card.getByText('Crop conditions unverified.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Selected point glide status')).toContainText('NM of route inside arrival range');
  expect(await page.evaluate(() => window.glideAudit.map.getPaintProperty('glide-point-ring', 'line-color'))).toBe('#a23bff');
  const data = () => page.evaluate(async () => await window.glideAudit.map.getSource<GeoJSONSource>('glide-point-area')!.getData());
  const first = await data();
  await page.evaluate(() => window.glideAudit.remount());
  await expect(card.getByText('Glide to selected area', { exact: true })).toBeVisible();
  await expect.poll(data).toEqual(first);
  await page.getByRole('slider', { name: 'Glide start altitude' }).fill('9500');
  await expect(page.getByLabel('Selected point glide status')).toContainText('NM of route inside arrival range');
  await expect.poll(data).not.toEqual(first);
  await page.screenshot({ path: testInfo.outputPath('landing-arrival.png') });
  await page.getByRole('switch', { name: 'Show off-field coverage' }).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId('errors')).toBeEmpty();
});

for (const recovery of ['refresh', 'remount'] as const) test(`a replaced landing source clears the selected site after ${recovery}`, async ({ page, context }) => {
  await serve(context);
  let current = fixture();
  await context.route('**/glide/manifest.json', route => route.fulfill({ json: current.manifest }));
  await context.route('**/glide/*.glide.gz', route => route.fulfill({ contentType: 'application/gzip', body: current.bytes }));
  await page.goto('/test/browser/glide.html');
  await page.getByRole('switch', { name: 'Show glide coverage' }).click();
  await page.getByRole('switch', { name: 'Show off-field coverage' }).click();
  await expect(page.getByRole('status', { name: 'Landing areas status' })).toHaveText('Landing-area density along your route');
  await selectRange(page); await inspectArea(page);
  const card = page.getByLabel('Selected glide point', { exact: true });
  await expect(card.getByText('Fit elevation up to 164 ft MSL.', { exact: true })).toBeVisible();
  current = fixture(500);
  // Refresh deliberately preserves the timestamp and input digest. Remount also
  // loses transient status, but must retain the selected record's source identity.
  if (recovery === 'remount') current.manifest.generatedAt = '2026-10-03T00:00:00Z';
  await page.evaluate(recovery => {
    if (recovery === 'remount') window.glideAudit.remount();
    else window.dispatchEvent(new Event('online'));
  }, recovery);
  await expect(card).toHaveCount(0);
  await expect.poll(() => page.evaluate(async () => (await window.glideAudit.map.getSource<GeoJSONSource>('glide-point-area')!.getData() as GeoJSON.FeatureCollection).features.length)).toBe(0);
  await expect(page.getByRole('status', { name: 'Landing areas status' })).toHaveText('Landing-area density along your route');
  await selectRange(page); await inspectArea(page);
  await expect(card.getByText('Fit elevation up to 1,640 ft MSL.', { exact: true })).toBeVisible();
  await expect(page.getByTestId('errors')).toBeEmpty();
});

test('GPS loss during inspection discards the retired worker error and permits a fresh selection', async ({ page, context }) => {
  await serve(context);
  await page.addInitScript(() => {
    const NativeWorker = Worker;
    window.Worker = class extends NativeWorker {
      readonly landing: boolean;
      constructor(url: string | URL, options?: WorkerOptions) { super(url, options); this.landing = String(url).includes('landing.worker'); }
      override postMessage(message: unknown, options: Transferable[] | StructuredSerializeOptions = []) {
        if (this.landing && (message as { path?: string[] }).path?.[0] === 'inspect'
          && document.documentElement.dataset.holdLandingInspection === 'true') {
          document.documentElement.dataset.pendingLandingInspection = 'true'; return;
        }
        if (Array.isArray(options)) super.postMessage(message, options); else super.postMessage(message, options);
      }
    };
  });
  await page.goto('/test/browser/glide.html');
  await page.waitForFunction(() => !!window.glideAudit);
  await page.evaluate(() => { window.glideAudit.route(null); window.glideAudit.ownship([-119.81, 34.42]); });
  await page.getByRole('switch', { name: 'Show glide coverage' }).click();
  await page.getByRole('switch', { name: 'Show off-field coverage' }).click();
  const status = page.getByRole('status', { name: 'Landing areas status' });
  await expect(status).toHaveText('2 candidate patches loaded');
  const select = async () => {
    await expect.poll(() => page.evaluate(() => window.glideAudit.map.queryRenderedFeatures({ layers: ['glide-landing-fill'] }).length)).toBeGreaterThan(0);
    const pixel = await page.evaluate(() => { const p = window.glideAudit.map.project([-119.81, 34.42]); return { x: p.x, y: p.y }; });
    await page.mouse.click(pixel.x, pixel.y, { button: 'right' });
    await page.getByRole('menuitem', { name: 'Inspect landing area', exact: true }).click();
  };
  await page.evaluate(() => { document.documentElement.dataset.holdLandingInspection = 'true'; });
  await select();
  await expect(page.locator('html')).toHaveAttribute('data-pending-landing-inspection', 'true');
  await page.evaluate(() => window.glideAudit.ownship(null, 'stale'));
  await expect(status).toHaveText('Add a route or show a glide range to see landing candidates');
  await expect(page.getByRole('button', { name: 'Retry landing areas' })).toHaveCount(0);
  await expect(page.getByLabel('Selected glide point', { exact: true })).toHaveCount(0);
  await page.evaluate(() => {
    document.documentElement.dataset.holdLandingInspection = 'false';
    window.glideAudit.ownship([-119.81, 34.42]);
  });
  await expect(status).toHaveText('2 candidate patches loaded');
  await select();
  await expect(page.getByLabel('Selected glide point', { exact: true })).toContainText('Glide to selected area');
  await expect(page.getByTestId('errors')).toBeEmpty();
});
