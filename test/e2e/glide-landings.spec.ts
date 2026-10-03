import { test, expect, type BrowserContext } from '@playwright/test';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { GeoJSONSource } from 'maplibre-gl';

function fixture() {
  const ring = (west: number, south: number, east: number, north: number) => {
    let x = 0, y = 0;
    return [[west, south], [east, south], [east, north], [west, north]].flatMap(([lon, lat]) => {
      const nx = Math.round(lon! * 1e6), ny = Math.round(lat! * 1e6), delta = [nx - x, ny - y];
      x = nx; y = ny; return delta;
    });
  };
  const fit = (tier: number) => [-119850000, 34420000, -119800000, 34420000, 200, tier === 2 ? 3000 : 1500, 50, tier];
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
  await context.route('**/glide/manifest.json', route => available()
    ? route.fulfill({ json: data.manifest }) : route.fulfill({ status: 404 }));
  await context.route('**/glide/*.glide.gz', route => {
    reads++; return route.fulfill({ contentType: 'application/gzip', body: data.bytes });
  });
  return () => reads;
}

test('prepared landing polygons have separate tiers, retain holes and survive pan/altitude changes without new acquisition', async ({ page, context }, testInfo) => {
  const reads = await serve(context);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/test/browser/glide.html');
  await page.waitForFunction(() => !!window.glideAudit);
  const toggle = page.getByRole('switch', { name: 'Show off-field coverage' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await page.getByRole('switch', { name: 'Show glide coverage' }).click();
  expect(reads()).toBe(0);
  await toggle.click();
  await expect(page.getByRole('status', { name: 'Landing areas status' })).toHaveText('2 candidate patches loaded');
  const data = () => page.evaluate(async () => await window.glideAudit.map.getSource<GeoJSONSource>('glide-landing-areas')!.getData() as GeoJSON.FeatureCollection<GeoJSON.MultiPolygon>);
  const initial = await data();
  expect(initial.features.map(feature => feature.properties!.tier)).toEqual([1, 2]);
  expect(initial.features[1]!.geometry.coordinates[0]!.length).toBe(2);
  expect(reads()).toBe(1);
  await expect(page.getByText('Includes cultivated fields; current crop and surface conditions are unverified.')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.glideAudit.map.queryRenderedFeatures({ layers: ['glide-landing-fill'] }).length)).toBeGreaterThan(0);
  await page.evaluate(() => {
    const source = window.glideAudit.map.getSource<GeoJSONSource>('glide-landing-areas')!, original = source.setData.bind(source);
    document.documentElement.dataset.landingPublishes = '0';
    source.setData = (...args: Parameters<typeof source.setData>) => {
      document.documentElement.dataset.landingPublishes = String(Number(document.documentElement.dataset.landingPublishes) + 1);
      return original(...args);
    };
    window.glideAudit.map.jumpTo({ center: [-119.80, 34.43], zoom: 9.5 });
  });
  await expect(page.getByRole('status', { name: 'Landing areas status' })).toHaveText('2 candidate patches loaded');
  await page.getByRole('slider', { name: 'Glide start altitude' }).fill('9500');
  expect(await data()).toEqual(initial); expect(reads()).toBe(1);
  await expect(page.locator('html')).toHaveAttribute('data-landing-publishes', '0');
  await page.screenshot({ path: testInfo.outputPath('glide-landing-areas.png') });
  await page.evaluate(() => window.glideAudit.route(null));
  await expect(page.getByRole('status', { name: 'Landing areas status' })).toHaveText('Add a route to see landing candidates');
  await expect.poll(async () => (await data()).features.length).toBe(0);
  await page.evaluate(() => window.glideAudit.route([[-120.1, 34.43], [-119.4, 34.43]]));
  await expect(page.getByRole('status', { name: 'Landing areas status' })).toHaveText('2 candidate patches loaded');
  expect(reads(), 'restored route reuses core file cache').toBe(1);
  await toggle.click();
  await expect.poll(async () => (await data()).features.length).toBe(0);
  await page.reload(); await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('errors')).toBeEmpty(); expect(errors).toEqual([]);
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
  await expect(page.getByRole('status', { name: 'Landing areas status' })).toHaveText('2 candidate patches loaded');
  await expect(page.getByTestId('errors')).toBeEmpty();
});
