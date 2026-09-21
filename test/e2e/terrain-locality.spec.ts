import type { GeoJSONSource } from 'maplibre-gl';
import { test, expect } from '@playwright/test';

for (const coverage of ['route', 'viewport']) test(`catalog metadata updates preserve ${coverage} terrain without new work`, async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).terrainRenderCalls = 0;
    const original = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function(this: Worker, message: any, ...args: any[]) {
      if (message?.path?.[0] === 'render') (window as any).terrainRenderCalls++;
      return (original as any).call(this, message, ...args);
    } as any;
  });
  await page.goto('/test/browser/terrain.html?zoom=11');
  await expect(page.locator('output[data-state]')).toHaveAttribute('data-state', 'ready', { timeout: 30000 });
  if (coverage === 'viewport') await page.getByLabel('Route terrain elevation').getByRole('button', { name: 'Viewport', exact: true }).click();
  await expect(page.locator('output[data-state]')).toHaveAttribute('data-state', 'ready', { timeout: 30000 });
  await expect(page.locator('body')).toHaveAttribute('data-map-idle', 'true');
  const result = await page.evaluate(async () => {
    const { map, refreshCatalog } = window.terrainMapAudit;
    const ids = ['route-terrain', 'route-terrain-contours', 'route-terrain-labels'];
    const sources = ids.map(id => map.getSource(id)), calls = (window as any).terrainRenderCalls;
    const order = map.getStyle().layers.map(layer => layer.id).join(',');
    let loads = 0;
    const loading = (event: { sourceId?: string }) => { if (ids.includes(event.sourceId ?? '')) loads++; };
    map.on('sourcedataloading', loading);
    const states: (string | null | undefined)[] = [];
    for (let i = 0; i < 4; i++) {
      const previous = document.body.dataset.terrainCatalog;
      refreshCatalog();
      while (document.body.dataset.terrainCatalog === previous) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      states.push(document.querySelector('output[data-state]')?.getAttribute('data-state'));
    }
    map.off('sourcedataloading', loading);
    return { sameSources: ids.every((id, i) => map.getSource(id) === sources[i]),
      sameOrder: map.getStyle().layers.map(layer => layer.id).join(',') === order,
      renders: (window as any).terrainRenderCalls - calls, loads, states };
  });
  expect(result).toEqual({ sameSources: true, sameOrder: true, renders: 0, loads: 0, states: ['ready', 'ready', 'ready', 'ready'] });
  await expect(page.getByTestId('errors')).toBeEmpty();
});

test('terrain preserves label ordering and updates cached vectors during a warm pan', async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).terrainRenderCalls = 0;
    const original = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function(this: Worker, message: any, ...args: any[]) {
      if (message?.path?.[0] === 'render') (window as any).terrainRenderCalls++;
      return (original as any).call(this, message, ...args);
    } as any;
  });
  await page.goto('/test/browser/terrain.html?zoom=11');
  await expect(page.locator('output[data-state]')).toHaveAttribute('data-state', 'ready', { timeout: 30000 });
  await expect(page.locator('body')).toHaveAttribute('data-map-idle', 'true');
  const initialOrder = await page.evaluate(() => window.terrainMapAudit.map.getStyle().layers.map((l: any) => l.id));
  await page.getByRole('button', { name: 'Clear route', exact: true }).click();
  await page.getByRole('button', { name: 'Restore route', exact: true }).click();
  await expect(page.locator('output[data-state]')).toHaveAttribute('data-state', 'ready', { timeout: 30000 });
  const restoredOrder = await page.evaluate(() => window.terrainMapAudit.map.getStyle().layers.map((l: any) => l.id));

  expect(initialOrder.indexOf('route-terrain-contour-labels')).toBeLessThan(initialOrder.indexOf('route-waypoint-labels'));
  expect(restoredOrder).toEqual(initialOrder);
  const audit = await page.evaluate(async () => {
    const map = window.terrainMapAudit.map;
    const settle = () => new Promise<void>(resolve => { map.once('idle', () => setTimeout(resolve, 350)); });
    const a: [number, number] = [-122.35, 37.5], b: [number, number] = [-121.95, 37.3];
    for (const center of [a, b, a]) { const idle = settle(); map.jumpTo({ center, zoom: 11 }); await idle; }
    const source = map.getSource('route-terrain-contours') as GeoJSONSource;
    const keys = () => map.coveringTiles({ tileSize: 512, minzoom: 8, maxzoom: 13, roundZoom: true })
      .map(({ canonical: { z, x, y } }: any) => `${z}/${x}/${y}`).sort();
    const startingKeys = keys(), renderCalls = (window as any).terrainRenderCalls;
    const startingData = await source.getData() as GeoJSON.FeatureCollection;
    const updates: { moving: boolean; keys: string[]; count: number }[] = [];
    const setData = source.setData;
    source.setData = function(data: any) { updates.push({ moving: map.isMoving(), keys: keys(), count: data.features.length }); return setData.call(this, data); };
    let movingFramesWithNewTiles = 0, movingFramesAfterVectorUpdate = 0;
    const moving = () => {
      if (!map.isMoving()) return;
      if (keys().some((key: string) => !startingKeys.includes(key))) movingFramesWithNewTiles++;
      if (updates.length) movingFramesAfterVectorUpdate++;
    };
    map.on('move', moving);
    const ended = new Promise<void>(resolve => map.once('moveend', () => resolve()));
    map.easeTo({ center: b, duration: 1600, easing: (t: number) => t });
    await ended;
    await new Promise(resolve => setTimeout(resolve, 350));
    map.off('move', moving);
    source.setData = setData;
    const finalData = await source.getData() as GeoJSON.FeatureCollection;
    return { startingKeys, finalKeys: keys(), movingFramesWithNewTiles, movingFramesAfterVectorUpdate,
      newTerrainRenders: (window as any).terrainRenderCalls - renderCalls, updates,
      startingFeatures: startingData.features.length, finalFeatures: finalData.features.length,
      dataChanged: JSON.stringify(startingData) !== JSON.stringify(finalData) };
  });
  await test.info().attach('warm-pan.json', { body: JSON.stringify(audit), contentType: 'application/json' });
  expect(audit.movingFramesWithNewTiles).toBeGreaterThan(10);
  expect(audit.newTerrainRenders).toBe(0);
  expect(audit.movingFramesAfterVectorUpdate).toBeGreaterThan(10);
  expect(audit.updates.some(update => update.moving)).toBe(true);
  expect(audit.updates.length).toBeLessThan(audit.movingFramesWithNewTiles);
  expect(audit.dataChanged).toBe(true);
  await expect(page.getByTestId('errors')).toBeEmpty();
});

test('repeated terrain visits keep cached contours and labels under cache pressure', async ({ page }) => {
  test.setTimeout(180000);
  await page.addInitScript(() => {
    (window as any).terrainRenderCalls = 0;
    (window as any).terrainRenderedKeys = new Set();
    const original = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function(this: Worker, message: any, ...args: any[]) {
      if (message?.path?.[0] === 'render') {
        (window as any).terrainRenderCalls++;
        const tile = message.argumentList?.[0]?.value?.tile;
        if (tile) (window as any).terrainRenderedKeys.add(`${tile.z}/${tile.x}/${tile.y}`);
      }
      return (original as any).call(this, message, ...args);
    } as any;
  });
  await page.goto('/test/browser/terrain.html?zoom=13');
  await expect(page.locator('output[data-state]')).toHaveAttribute('data-state', 'ready', { timeout: 30000 });
  await expect(page.locator('body')).toHaveAttribute('data-map-idle', 'true');
  const audit = await page.evaluate(async () => {
    const map = window.terrainMapAudit.map;
    const jump = async (center: [number, number]) => {
      const ready = new Promise<void>(resolve => map.once('idle', () => setTimeout(resolve, 150)));
      map.jumpTo({ center, zoom: 13 }); await ready;
    };
    const features = async () => ((await (map.getSource('route-terrain-contours') as GeoJSONSource).getData()) as GeoJSON.FeatureCollection).features.length;
    const anchor: [number, number] = [-122.35, 37.5];
    await jump(anchor);
    const originalFeatures = await features();
    const visits: any[] = [];
    for (const latitude of [37.52, 37.42, 37.32, 37.22, 37.62, 37.12]) {
      for (const longitude of [-122.1, -122.0, -121.9, -121.8, -121.7, -122.2, -122.45]) {
        await jump([longitude, latitude]);
        const before = (window as any).terrainRenderCalls;
        await jump(anchor);
        const visit = { uniqueTiles: (window as any).terrainRenderedKeys.size,
          newRendersOnRevisit: (window as any).terrainRenderCalls - before, features: await features() };
        visits.push(visit);
        if (visit.uniqueTiles > 150) {
          return { originalFeatures, visits, exercisedCacheLimit: true,
            status: document.querySelector('output[data-state]')?.getAttribute('data-state'),
            finalLabels: ((await (map.getSource('route-terrain-labels') as GeoJSONSource).getData()) as GeoJSON.FeatureCollection).features.length };
        }
      }
    }
    return { originalFeatures, visits, exercisedCacheLimit: false };
  });
  await test.info().attach('cache-pressure.json', { body: JSON.stringify(audit), contentType: 'application/json' });
  expect(audit.originalFeatures).toBeGreaterThan(0);
  expect(audit.exercisedCacheLimit).toBe(true);
  expect(audit.visits.every(visit => visit.features === audit.originalFeatures)).toBe(true);
  expect(audit.visits.every(visit => visit.newRendersOnRevisit === 0)).toBe(true);
  expect(audit.finalLabels).toBeGreaterThan(0);
  expect(audit.status).toBe('ready');
  await expect(page.getByTestId('errors')).toBeEmpty();
});
