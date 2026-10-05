import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { ImageSource } from 'maplibre-gl';
import { terrainPng } from './terrain-fixture.mjs';

test('dense ranges render every original ring past the vertex budget, preserve tier overlap, and reuse warm images', async ({ page }) => {
  await page.goto('/test/browser/glide.html');
  const result = await page.evaluate(async () => {
    const { display, raster, project } = window.glideRasterAudit;
    const rect = (w: number, s: number, e: number, n: number): [number, number][] => [[w, s], [e, s], [e, n], [w, n], [w, s]];
    const box: [number, number, number, number] = [-.5, -.2, .5, .2];
    const circle = Array.from({ length: 310001 }, (_, i): [number, number] => project([-.2 + .06 * Math.cos(i / 310000 * Math.PI * 2), .06 * Math.sin(i / 310000 * Math.PI * 2)]));
    const common = { start: [0, 0] as [number, number], end: [.01, 0] as [number, number], widthFt: 200, lengthFt: 3000, elevationM: 50 };
    const areas = [
      { ...common, id: 'large', tier: 2 as const, flags: 1, polygon: [circle, rect(-.21, -.01, -.19, .01).map(project)] },
      { ...common, id: 'preferred', tier: 2 as const, flags: 0, polygon: [rect(.1, -.06, .25, .06).map(project)] },
      { ...common, id: 'fallback', tier: 1 as const, flags: 32, polygon: [rect(.05, -.08, .28, .08).map(project)] },
    ];
    const shards = areas.map((a, i) => ({ id: String(i), file: String(i), sha256: String(i), bytes: 100, rawBytes: 100, bounds: box, count: 1, tiers: [a.tier === 1 ? 1 : 0, a.tier === 2 ? 1 : 0] as [number, number] }));
    const manifest = { schemaVersion: 8 as const, builderVersion: 1, generatedAt: '2026-10-03T00:00:00Z', inputSha256: 'a'.repeat(64),
      status: 'experimental-candidates' as const, geometryMeaning: 'generalized-candidate-area' as const, coverage: [{ id: 'test', bounds: box }], shards };
    let reads = 0;
    const worker = display(async () => manifest, async () => { throw Error('No route overview'); }, async (_url, shard) => { reads++; return [areas[Number(shard.id)]!]; });
    const query = { id: 1, manifestUrl: 'https://example.test/glide', discover: true, segments: [], bounds: box, zoom: 10,
      ranges: { type: 'FeatureCollection' as const, features: [{ type: 'Feature' as const, properties: {}, geometry: { type: 'MultiPolygon' as const, coordinates: [[rect(-.35, -.15, .35, .15)]] } }] } };
    let response = await worker.query(query), progress = response.more, image = response.raster;
    for (let i = 0; response.more && i < 10; i++) {
      const move = (i + 1) * .0001;
      response = await worker.query({ ...query, bounds: [box[0] + move, box[1], box[2] + move, box[3]],
        ranges: { ...query.ranges, features: [{ ...query.ranges.features[0]!, geometry: { type: 'MultiPolygon', coordinates: [[rect(-.35 + move, -.15, .35 + move, .15)]] } }] },
        renderedKey: response.renderKey }); image = response.raster ?? image;
    }
    const pixel = (lon: number, lat: number, img = image!) => {
      const nw = project([img.bounds[0], img.bounds[3]]), se = project([img.bounds[2], img.bounds[1]]), p = project([lon, lat]);
      const x = Math.floor((p[0] - nw[0]) / (se[0] - nw[0]) * img.width), y = Math.floor((p[1] - nw[1]) / (se[1] - nw[1]) * img.height);
      return [...img.rgba.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];
    };
    response = await worker.query({ ...query, renderedKey: response.renderKey });
    const before = reads, warm = await worker.query({ ...query, renderedKey: response.renderKey });
    const warmReads = reads - before;
    const inspected = [(await worker.inspect([-.17, 0]))?.id, await worker.inspect([-.2, 0]), (await worker.inspect([.15, 0]))?.id];
    // The same renderer must honor saved-region ownership and longitude copies.
    const scope = { include: [{ id: 'saved', bounds: [[-.5, -.2, 0, .2] as typeof box] }], exclude: [] };
    const scoped = raster(async (_url, shard) => [areas[Number(shard.id)]!]);
    let restricted = await scoped.query(query, { ...manifest, shards: shards.map(s => ({ ...s, scope })) });
    for (let i = 0; restricted.more && i < 10; i++) restricted = await scoped.query(query, { ...manifest, shards: shards.map(s => ({ ...s, scope })) });
    const outsideScope = pixel(.15, 0, restricted.raster!), scopedInspect = await scoped.inspect([.15, 0]);
    const wrapped = await worker.query({ ...query, bounds: [359.5, -.2, 360.5, .2] });
    const lost = await worker.query({ ...query, ranges: { type: 'FeatureCollection', features: [] } });
    const partialWorker = display(async () => manifest, async () => { throw Error('No overview'); }, async (_url, shard) => {
      if (shard.id === '2') throw Error('offline'); return [areas[Number(shard.id)]!];
    });
    let partial = await partialWorker.query(query);
    for (let i = 0; partial.more && i < 10; i++) partial = await partialWorker.query(query);
    return { state: response.status.state, progress, more: response.more, size: [image!.width, image!.height], left: pixel(-.17, 0),
      hole: pixel(-.2, 0), green: pixel(.15, 0), purple: pixel(.07, 0), outside: pixel(.4, 0), warmReads,
      unchanged: warm.raster === undefined && warm.collection === undefined, inspected, outsideScope, scopedInspect,
      partial: partial.status.state, partialImage: !!partial.raster?.shadedCells,
      wrapped: !!wrapped.raster?.shadedCells, cleared: lost.raster === null && await worker.inspect([-.17, 0]) === null };
  });
  expect(result.state).toBe('ready'); expect(result.progress).toBe(true); expect(result.more).toBe(false);
  expect(Math.max(...result.size)).toBeLessThanOrEqual(1536);
  expect(result.left[3]).toBeGreaterThan(0); expect(result.hole[3]).toBe(0); expect(result.outside[3]).toBe(0);
  expect(result.green.slice(0, 3)).toEqual([83, 229, 45]); expect(result.purple.slice(0, 3)).toEqual([162, 59, 255]);
  expect(result.warmReads).toBe(0); expect(result.unchanged).toBe(true);
  expect(result.inspected).toEqual(['large', null, 'preferred']); expect(result.outsideScope[3]).toBe(0); expect(result.scopedInspect).toBeNull();
  expect(result.wrapped).toBe(true); expect(result.cleared).toBe(true);
  expect(result.partial).toBe('partial'); expect(result.partialImage).toBe(true);
});

test('more than 24 detail blocks finish on the map, remain inspectable and reload from offline cache', async ({ page, context }, testInfo) => {
  const centers: [number, number][] = [], files = new Map<string, Buffer>();
  const ring = (w: number, s: number, e: number, n: number) => {
    let x = 0, y = 0;
    return [[w, s], [e, s], [e, n], [w, n]].flatMap(([lon, lat]) => {
      const nx = Math.round(lon! * 1e6), ny = Math.round(lat! * 1e6), delta = [nx - x, ny - y]; x = nx; y = ny; return delta;
    });
  };
  const shards = Array.from({ length: 26 }, (_, i) => {
    const lon = -119.822 + i % 13 * .007, lat = 36.725 + Math.floor(i / 13) * .03; centers.push([lon, lat]);
    const bounds = [lon - .0025, lat - .01, lon + .0025, lat + .01];
    const data = JSON.stringify([[[Math.round(lon * 1e6), Math.round(lat * 1e6), Math.round((lon + .001) * 1e6), Math.round(lat * 1e6), 200, 3000, 50, 2],
      [ring(...bounds as [number, number, number, number]), ring(lon - .001, lat - .002, lon + .001, lat + .002)], 1]]);
    const bytes = gzipSync(data), sha256 = createHash('sha256').update(bytes).digest('hex'), file = `${sha256}.glide.gz`; files.set(file, bytes);
    return { id: String(i), file, sha256, bytes: bytes.length, rawBytes: Buffer.byteLength(data), bounds, count: 1, tiers: [0, 1] };
  });
  await context.route('**/terrain/*/*/*.png', route => {
    const match = /terrain\/(\d+)\/(\d+)\/(\d+)\.png/.exec(route.request().url())!;
    return route.fulfill({ contentType: 'image/png', body: terrainPng(Number(match[1]), Number(match[2]), Number(match[3]), () => 0) });
  });
  await context.route('**/glide/manifest.json', route => route.fulfill({ json: { schemaVersion: 8, builderVersion: 1,
    status: 'experimental-candidates', geometryMeaning: 'generalized-candidate-area', generatedAt: '2026-10-03T00:00:00Z', inputSha256: 'b'.repeat(64),
    coverage: [{ id: 'fresno', bounds: [-121, 35, -118, 38] }], shards } }));
  let reads = 0;
  const readOrder: number[] = [];
  await context.route('**/glide/*.glide.gz', route => {
    reads++; const file = new URL(route.request().url()).pathname.split('/').pop()!;
    readOrder.push(shards.findIndex(shard => shard.file === file));
    return route.fulfill({ contentType: 'application/gzip', body: files.get(file)! });
  });
  const focus = async () => {
    await page.waitForFunction(() => !!window.glideAudit);
    await page.evaluate(() => { window.glideAudit.route(null); window.glideAudit.map.jumpTo({ center: [-119.745, 36.74], zoom: 11 }); window.glideAudit.ownship([-119.81, 36.74]); });
  };
  await page.goto('/test/browser/glide.html'); await focus();
  await page.getByRole('switch', { name: 'Show glide coverage' }).click();
  await page.getByRole('switch', { name: 'Show off-field coverage' }).click();
  const status = page.getByRole('status', { name: 'Landing areas status' });
  await expect(status).toHaveText('Candidate areas loaded');
  const samples = () => page.evaluate(centers => {
    const source = window.glideAudit.map.getSource<ImageSource>('glide-landing-detail-image')!, image = source.image as ImageData;
    const a = source.coordinates[0]!, b = source.coordinates[2]!;
    const my = (lat: number) => (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2;
    return centers.map(([lon, lat]) => [lat, lat + .006].map(y => {
      const col = Math.floor((lon - a[0]!) / (b[0]! - a[0]!) * image.width), row = Math.floor((my(y) - my(a[1]!)) / (my(b[1]!) - my(a[1]!)) * image.height);
      return image.data[(row * image.width + col) * 4 + 3]!;
    }));
  }, centers);
  expect((await samples()).every(([hole, solid]) => hole === 0 && solid! > 0)).toBe(true);
  expect(reads).toBe(26);
  expect([...readOrder.slice(0, 2)].sort((a, b) => a - b), 'the map publishes the calculation origin, independent of the panned camera').toEqual([2, 15]);
  await page.screenshot({ path: testInfo.outputPath('complete-dense-glide-range.png') });
  await page.evaluate(() => window.glideAudit.map.jumpTo({ zoom: 6 }));
  await expect(status).toHaveText('Zoom in to load more landing areas');
  expect((await samples()).every(([hole, solid]) => hole === 0 && solid! > 0), 'cached detail survives the discovery cutoff').toBe(true);
  expect(await page.evaluate(() => window.glideAudit.map.getLayoutProperty('glide-landing-detail-image', 'visibility'))).toBe('visible');
  expect(reads).toBe(26);
  await page.evaluate(() => window.glideAudit.map.jumpTo({ zoom: 11 }));
  await expect(status).toHaveText('Candidate areas loaded');
  const target = centers[25]!;
  const point = await page.evaluate(([lon, lat]) => { const p = window.glideAudit.map.project([lon!, lat! + .006]); return { x: p.x, y: p.y }; }, target);
  await page.mouse.click(point.x, point.y, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Inspect landing area', exact: true }).click();
  await expect(page.getByLabel('Selected glide point', { exact: true })).toContainText('Preferred · 3,000 × 200 ft fit');
  expect(reads).toBe(26);
  await context.route('**/chart-data/glide/**', route => route.abort('internetdisconnected'));
  await page.reload(); await focus(); await expect(status).toHaveText('Candidate areas loaded');
  expect((await samples()).every(([hole, solid]) => hole === 0 && solid! > 0)).toBe(true);
  await page.evaluate(() => window.glideAudit.ownship(null, 'stale'));
  await expect.poll(() => page.evaluate(() => window.glideAudit.map.getLayoutProperty('glide-landing-detail-image', 'visibility'))).toBe('none');
  await expect(page.getByTestId('errors')).toBeEmpty();
});


test('dense rendering preserves completed blocks through cancellation, range changes, failed reads, and retry', async ({ page }) => {
  await page.goto('/test/browser/glide.html');
  const result = await page.evaluate(async () => {
    const { raster, project } = window.glideRasterAudit;
    const box: [number, number, number, number] = [-.5, -.2, .5, .2];
    const rect = (w: number, e: number): [number, number][] => [[w, -.05], [e, -.05], [e, .05], [w, .05], [w, -.05]];
    const shards = [0, 1, 2].map(i => ({ id: String(i), file: String(i), sha256: String(i), bytes: 100, rawBytes: 100, bounds: [-.3 + i * .2, -.05, -.2 + i * .2, .05] as typeof box, count: 1, tiers: [0, 1] as [number, number] }));
    const manifest = { schemaVersion: 8 as const, builderVersion: 1, generatedAt: '2026-10-03T00:00:00Z', inputSha256: 'a'.repeat(64),
      status: 'experimental-candidates' as const, geometryMeaning: 'generalized-candidate-area' as const, coverage: [{ id: 'test', bounds: box }], shards };
    let hold = true, unavailable = true, release!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), start = new Promise<void>(resolve => { started = resolve; });
    const reads: string[] = [];
    const worker = raster(async (_url, shard) => {
      reads.push(shard.id);
      if (shard.id === '2' && hold) { started(); await gate; }
      if (shard.id === '2' && unavailable) throw Error('offline');
      const x = -.3 + Number(shard.id) * .2;
      return [{ id: shard.id, tier: 2, flags: 0, start: [x, 0], end: [x + .1, 0], widthFt: 200, lengthFt: 3000, elevationM: 50,
        polygon: [rect(x, x + .1).map(project)] }];
    });
    const query = { id: 1, manifestUrl: 'https://example.test/glide', discover: true, segments: [], bounds: box, zoom: 10,
      ranges: { type: 'FeatureCollection' as const, features: [{ type: 'Feature' as const, properties: {}, geometry: { type: 'MultiPolygon' as const, coordinates: [[rect(-.4, .4)]] } }] } };
    const pending = worker.query(query, manifest); await start; worker.cancel(1); hold = false; release();
    let aborted = false; try { await pending; } catch (error) { aborted = (error as Error).name === 'AbortError'; }
    const moved = { ...query, id: 2, bounds: [-.4999, -.2, .5001, .2] as typeof box,
      ranges: { ...query.ranges, features: [{ ...query.ranges.features[0]!, geometry: { type: 'MultiPolygon' as const, coordinates: [[rect(-.15, .4)]] } }] } };
    const partial = await worker.query(moved, manifest), firstReads = [...reads];
    const before = reads.length; await worker.query({ ...moved, renderedKey: partial.renderKey }, manifest);
    const noSpin = before === reads.length;
    const removed = await worker.inspect([-.25, 0]);
    const smaller = { ...moved, ranges: { ...moved.ranges, features: [{ ...moved.ranges.features[0]!, geometry: { type: 'MultiPolygon' as const, coordinates: [[rect(-.15, .05)]] } }] } };
    const away = await worker.query(smaller, manifest);
    unavailable = false;
    const recovered = await worker.query({ ...moved, revalidate: true }, manifest);
    const newSite = await worker.inspect([.15, 0]);
    const previous = newSite!.sourceKey, completedReads = reads.length;
    const outside = await worker.query({ ...moved, ranges: { ...moved.ranges, features: [{ ...moved.ranges.features[0]!, geometry: { type: 'MultiPolygon', coordinates: [[rect(.8, .9)]] } }] } }, manifest);
    const noOutsideReads = completedReads === reads.length;
    const changed = await worker.query(moved, { ...manifest, inputSha256: 'b'.repeat(64) });
    return { aborted, firstReads, noSpin, removed, partial: partial.status.state, recovered: recovered.status.state,
      away: away.status.state, outside: outside.status.state, noOutsideReads,
      newId: newSite?.id, sourceChanged: previous !== changed.status.sourceKey, more: changed.more };
  });
  expect(result.aborted).toBe(true); expect(result.firstReads).toEqual(['1', '2', '2']);
  expect(result.noSpin).toBe(true); expect(result.removed).toBeNull(); expect(result.partial).toBe('partial');
  expect(result.recovered).toBe('ready'); expect(result.newId).toBe('2'); expect(result.sourceChanged).toBe(true); expect(result.more).toBe(false);
  expect(result.away).toBe('ready'); expect(result.outside).toBe('outside'); expect(result.noOutsideReads).toBe(true);
});


test('dense images load outward from both range origins and reprioritize pending blocks after an origin moves', async ({ page }) => {
  await page.goto('/test/browser/glide.html');
  const result = await page.evaluate(async () => {
    const { raster, project } = window.glideRasterAudit;
    const positions = [.4, .2, -.05, -.25, -.4]; // Far-to-near file order for the first origin.
    const rect = (w: number, e: number): [number, number][] => [[w, -.025], [e, -.025], [e, .025], [w, .025], [w, -.025]];
    const bounds: [number, number, number, number] = [-.5, -.1, .5, .1];
    const shards = positions.map((x, i) => ({ id: String(i), file: String(i), sha256: String(i), bytes: 100, rawBytes: 100,
      bounds: [x - .02, -.025, x + .02, .025] as typeof bounds, count: 1, tiers: [0, 1] as [number, number] }));
    const manifest = { schemaVersion: 8 as const, builderVersion: 1, generatedAt: '2026-10-03T00:00:00Z', inputSha256: 'a'.repeat(64),
      status: 'experimental-candidates' as const, geometryMeaning: 'generalized-candidate-area' as const, coverage: [{ id: 'test', bounds }], shards };
    const ranges = (origins: [number, number][]) => ({ type: 'FeatureCollection' as const, features: origins.map(glideOrigin => ({
      type: 'Feature' as const, properties: { glideOrigin }, geometry: { type: 'MultiPolygon' as const, coordinates: [[rect(-.49, .49)]] },
    })) });
    const reads: string[] = [];
    const load = async (_url: string, shard: typeof shards[number]) => {
      reads.push(shard.id); const x = positions[Number(shard.id)]!;
      return [{ id: shard.id, tier: 2 as const, flags: 0, start: [x, 0] as [number, number], end: [x + .01, 0] as [number, number],
        widthFt: 200, lengthFt: 3000, elevationM: 50, polygon: [rect(x - .02, x + .02).map(project)] }];
    };
    const worker = raster(load), query = { id: 1, manifestUrl: 'https://example.test/glide', bounds, zoom: 10, discover: true, segments: [], ranges: ranges([[-.4, 0]]) };
    const first = await worker.query(query, manifest), firstReads = [...reads];
    const near = (await worker.inspect([-.4, 0]))?.id, outer = await worker.inspect([.4, 0]);
    reads.length = 0;
    const second = await worker.query({ ...query, ranges: ranges([[.4, 0]]), renderedKey: first.renderKey }, manifest), secondReads = [...reads];
    reads.length = 0;
    const done = await worker.query({ ...query, ranges: ranges([[.4, 0]]), renderedKey: second.renderKey }, manifest), lastReads = [...reads];
    reads.length = 0;
    await raster(load).query({ ...query, ranges: ranges([[-.4, 0], [.4, 0]]) }, manifest);
    return { firstReads, near, outer, secondReads, lastReads, both: [...reads], firstMore: first.more, done: done.status.state, more: done.more };
  });
  expect(result.firstReads).toEqual(['4', '3']); expect(result.near).toBe('4'); expect(result.outer).toBeNull(); expect(result.firstMore).toBe(true);
  expect(result.secondReads).toEqual(['0', '1']); expect(result.lastReads).toEqual(['2']);
  expect(result.done).toBe('ready'); expect(result.more).toBe(false); expect(result.both).toEqual(['0', '4']);
});

for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
  test(`dense loading survives track-up bearing changes at ${viewport.width} × ${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/test/browser/glide.html');
    await page.waitForFunction(() => !!window.glideAudit);
    const result = await page.evaluate(async () => {
      const { raster, project } = window.glideRasterAudit, { map } = window.glideAudit;
      map.jumpTo({ center: [0, 0], zoom: 10, bearing: 0 });
      const rect = (w: number, e: number): [number, number][] => [[w, -.01], [e, -.01], [e, .01], [w, .01], [w, -.01]];
      const bounds: [number, number, number, number] = [-1, -1, 1, 1];
      const shards = Array.from({ length: 8 }, (_, i) => ({ id: String(i), file: String(i), sha256: String(i), bytes: 100, rawBytes: 100,
        bounds: [-.075 + i * .02, -.01, -.065 + i * .02, .01] as typeof bounds, count: 1, tiers: [0, 1] as [number, number] }));
      const manifest = { schemaVersion: 8 as const, builderVersion: 1, generatedAt: '2026-10-03T00:00:00Z', inputSha256: 'a'.repeat(64),
        status: 'experimental-candidates' as const, geometryMeaning: 'generalized-candidate-area' as const, coverage: [{ id: 'test', bounds }], shards };
      const reads: string[] = [];
      const worker = raster(async (_url, shard) => {
        reads.push(shard.id); const [w, , e] = shard.bounds;
        return [{ id: shard.id, tier: 2, flags: 0, start: [w, 0], end: [e, 0], widthFt: 200, lengthFt: 3000, elevationM: 50,
          polygon: [rect(w, e).map(project)] }];
      });
      const query = { id: 1, manifestUrl: 'https://example.test/glide', discover: true, segments: [],
        ranges: { type: 'FeatureCollection' as const, features: [{ type: 'Feature' as const, properties: { glideOrigin: [0, 0] },
          geometry: { type: 'MultiPolygon' as const, coordinates: [[rect(-.1, .1)]] } }] } };
      const camera = () => {
        const b = map.getBounds();
        return { bounds: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()] as typeof bounds, zoom: map.getZoom() };
      };
      let response = await worker.query({ ...query, ...camera() }, manifest);
      const frame = response.raster!.bounds, firstMore = response.more;
      for (const bearing of [.5, 1, 1.5]) {
        map.jumpTo({ bearing }, { gpsCamera: true });
        response = await worker.query({ ...query, ...camera(), renderedKey: response.renderKey }, manifest);
      }
      const complete = { state: response.status.state, more: response.more, reads: [...reads], frame: response.raster!.bounds };
      let unchanged = true;
      for (const bearing of [2, 1, 0]) {
        map.jumpTo({ bearing }, { gpsCamera: true });
        response = await worker.query({ ...query, ...camera(), renderedKey: response.renderKey }, manifest);
        unchanged &&= response.raster === undefined;
      }
      const warmReads = reads.length;
      map.jumpTo({ zoom: 10.5 });
      const zoomed = await worker.query({ ...query, ...camera(), renderedKey: response.renderKey }, manifest);
      return { firstMore, frame, complete, unchanged, warmReads, zoomReads: reads.length - warmReads, zoomImage: !!zoomed.raster };
    });
    expect(result.firstMore).toBe(true); expect(result.complete.state).toBe('ready'); expect(result.complete.more).toBe(false);
    expect(result.complete.reads).toHaveLength(8); expect(new Set(result.complete.reads).size).toBe(8);
    expect(result.complete.frame).toEqual(result.frame); expect(result.unchanged).toBe(true); expect(result.warmReads).toBe(8);
    expect(result.zoomReads).toBe(2); expect(result.zoomImage).toBe(true);
  });
}

test('superseded dense inspections return no selection while current read failures remain errors', async ({ page }) => {
  await page.goto('/test/browser/glide.html');
  const result = await page.evaluate(async () => {
    const { raster, project } = window.glideRasterAudit;
    const rect = (w: number, e: number): [number, number][] => [[w, -.05], [e, -.05], [e, .05], [w, .05], [w, -.05]];
    const bounds: [number, number, number, number] = [-.5, -.2, .5, .2];
    let manifest = { schemaVersion: 8 as const, builderVersion: 1, generatedAt: '2026-10-03T00:00:00Z', inputSha256: 'a'.repeat(64),
      status: 'experimental-candidates' as const, geometryMeaning: 'generalized-candidate-area' as const, coverage: [{ id: 'test', bounds }],
      shards: [{ id: 'site', file: 'site', sha256: 'site', bytes: 100, rawBytes: 100, bounds, count: 1, tiers: [0, 1] as [number, number] }] };
    let held: { started(): void; wait: Promise<void>; abortable: boolean } | undefined, fail = false;
    const worker = raster(async (_url, _shard, signal) => {
      const pending = held; held = undefined;
      if (pending) {
        pending.started();
        if (pending.abortable) await Promise.race([pending.wait, new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        })]);
        else await pending.wait; // A completed shared read can still outlive its consumer.
      }
      if (fail) throw Error('missing candidate block');
      return [{ id: 'site', tier: 2, flags: 0, start: [-.02, 0], end: [.02, 0], widthFt: 200, lengthFt: 3000, elevationM: 50,
        polygon: [rect(-.05, .05).map(project)] }];
    });
    const ranges = (w: number) => ({ type: 'FeatureCollection' as const, features: [{ type: 'Feature' as const, properties: {},
      geometry: { type: 'MultiPolygon' as const, coordinates: [[rect(w, .1)]] } }] });
    let query = { id: 1, manifestUrl: 'https://example.test/glide', discover: true, segments: [], bounds, zoom: 10, ranges: ranges(-.1) };
    await worker.query(query, manifest);
    const cancelled = [], fresh = [], states = [];
    for (const change of ['range', 'source']) {
      let release!: () => void, started!: () => void;
      const wait = new Promise<void>(resolve => { release = resolve; }), start = new Promise<void>(resolve => { started = resolve; });
      held = { started, wait, abortable: change === 'source' };
      const pending = worker.inspect([0, 0]).then(site => ({ id: site?.id ?? null, error: null }), (error: Error) => ({ id: null, error: error.message }));
      await start;
      if (change === 'range') query = { ...query, ranges: ranges(-.04) };
      else manifest = { ...manifest, inputSha256: 'b'.repeat(64) };
      const updated = await worker.query(query, manifest); states.push(updated.status.state);
      release(); cancelled.push(await pending);
      const site = await worker.inspect([0, 0]); fresh.push({ id: site?.id, current: site?.sourceKey === updated.status.sourceKey });
    }
    fail = true;
    const error = await worker.inspect([0, 0]).then(() => null, (error: Error) => error.message);
    fail = false;
    return { cancelled, fresh, states, error, recovered: (await worker.inspect([0, 0]))?.id };
  });
  expect(result.cancelled).toEqual([{ id: null, error: null }, { id: null, error: null }]);
  expect(result.fresh).toEqual([{ id: 'site', current: true }, { id: 'site', current: true }]);
  expect(result.states).toEqual(['ready', 'ready']); expect(result.error).toBe('missing candidate block'); expect(result.recovered).toBe('site');
});
