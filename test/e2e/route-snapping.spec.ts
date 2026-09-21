import { expect, test, type Page } from '@playwright/test';
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';

declare global { interface Window {
  routeMapAudit: { map: MapLibreMap };
  routeDragWrites: Array<{ source: string; features: number }>;
} }

test.use({ hasTouch: true });

async function positions(page: Page, label = false) {
  await page.goto(`/test/browser/route-map.html?snapping${label ? '&snapLabel' : ''}`);
  await page.waitForFunction(() => {
    const map = window.routeMapAudit?.map;
    return map?.getLayer('snap-target') && map.queryRenderedFeatures({ layers: ['snap-target'] }).length &&
      map.queryRenderedFeatures({ layers: ['route-leg-hits'] }).length;
  });
  return page.evaluate(() => {
    const map = window.routeMapAudit.map;
    const start = map.project([-119, 35]), target = map.project([-119, 36]);
    return { start: { x: start.x, y: start.y }, target: { x: target.x, y: target.y } };
  });
}

async function expectSnap(page: Page, snapped: boolean) {
  await page.waitForFunction(async snapped => {
    const map = window.routeMapAudit.map;
    const data = await (map.getSource('route-drag') as GeoJSONSource).getData();
    return map.getGlobalState()['zlayer-route-drag-visible'] === true &&
      data.type === 'FeatureCollection' && data.features.some(feature => feature.properties?.routeKind === 'insert-preview' &&
      feature.properties.snapped === snapped) && map.queryRenderedFeatures({ layers: ['route-insert-preview'] })
      .some(feature => feature.properties.snapped === snapped);
  }, snapped);
}

for (const touch of [false, true]) {
  test(`a rendered long label captures and retains its distant anchor (${touch ? 'touch' : 'mouse'})`, async ({ page }) => {
    const { start, target } = await positions(page, true);
    const hit = { x: target.x + 100, y: target.y };
    await page.waitForFunction(point => window.routeMapAudit.map.queryRenderedFeatures([point.x, point.y], { layers: ['snap-label'] }).length > 0, hit);
    await page.waitForFunction(point => window.routeMapAudit.map.queryRenderedFeatures([point.x + 45, point.y], { layers: ['snap-label'] }).length > 0, hit);
    const session = touch ? await page.context().newCDPSession(page) : undefined;
    const move = async (x: number) => {
      if (session) await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: hit.y }] });
      else await page.mouse.move(x, hit.y);
    };
    if (session) await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
    else { await page.mouse.move(start.x, start.y); await page.mouse.down(); }
    await move(hit.x);
    await expectSnap(page, true);
    await page.evaluate(() => window.routeMapAudit.map.setLayoutProperty('snap-label', 'visibility', 'none'));
    await page.waitForFunction(() => !window.routeMapAudit.map.queryRenderedFeatures({ layers: ['snap-label'] }).length);
    for (const offset of [2, 15, 30, 45]) {
      await move(hit.x + offset);
      await expectSnap(page, true);
    }
    if (session) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await session.detach();
    } else await page.mouse.up();
    await expect(page.getByLabel('Route', { exact: true })).toHaveText('KSBA TAILS KSMX');
    await expect(page.getByLabel('Edits')).toHaveText('1');
    await expect(page.getByRole('alert')).toBeEmpty();
  });

  test(`leg snaps stay stable through boundary movement and disappearing symbols (${touch ? 'touch' : 'mouse'})`, async ({ page }) => {
    const { start, target } = await positions(page);
    const session = touch ? await page.context().newCDPSession(page) : undefined;
    const move = async (offset: number) => {
      const point = { x: target.x + offset, y: target.y };
      if (session) await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point] });
      else await page.mouse.move(point.x, point.y);
    };
    if (session) await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
    else { await page.mouse.move(start.x, start.y); await page.mouse.down(); }
    await move(20);
    await expectSnap(page, true);
    for (const offset of [23, 25, 23, 29, 34]) {
      await move(offset);
      await expectSnap(page, true);
    }
    await move(45);
    await expectSnap(page, false);
    await move(32);
    await expectSnap(page, false);
    await move(20);
    await expectSnap(page, true);
    // Simulate placement / source refresh removing an already captured symbol.
    await page.evaluate(() => window.routeMapAudit.map.setLayoutProperty('snap-target', 'visibility', 'none'));
    await page.waitForFunction(() => window.routeMapAudit.map.queryRenderedFeatures({ layers: ['snap-target'] }).length === 0);
    for (const offset of [23, 25, 21]) {
      await move(offset);
      await expectSnap(page, true);
    }
    if (session) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await session.detach();
    } else await page.mouse.up();
    await expect(page.getByLabel('Route', { exact: true })).toHaveText('KSBA TAILS KSMX');
    await expect(page.getByLabel('Edits')).toHaveText('1');
    await expect(page.getByRole('alert')).toBeEmpty();
  });

  test(`a stationary release preserves the preview when a target becomes visible (${touch ? 'touch' : 'mouse'})`, async ({ page }) => {
    const { start, target } = await positions(page);
    await page.evaluate(() => window.routeMapAudit.map.setLayoutProperty('snap-target', 'visibility', 'none'));
    await page.waitForFunction(() => !window.routeMapAudit.map.queryRenderedFeatures({ layers: ['snap-target'] }).length);
    const session = touch ? await page.context().newCDPSession(page) : undefined;
    const end = { x: target.x + 20, y: target.y };
    if (session) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [end] });
    } else {
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(end.x, end.y);
    }
    await expectSnap(page, false);
    await page.evaluate(() => window.routeMapAudit.map.setLayoutProperty('snap-target', 'visibility', 'visible'));
    await page.waitForFunction(() => window.routeMapAudit.map.queryRenderedFeatures({ layers: ['snap-target'] }).length === 1);
    if (session) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await session.detach();
    } else await page.mouse.up();
    await expect(page.getByLabel('Route', { exact: true })).toHaveText(/^KSBA \d{6}N\d{7}W KSMX$/);
    await expect(page.getByLabel('Edits')).toHaveText('1');
    await expect(page.getByRole('alert')).toBeEmpty();
  });
}

test('a deliberate click immediately after cancellation selects normally', async ({ page }) => {
  const { start, target } = await positions(page);
  const airport = await page.evaluate(() => {
    const point = window.routeMapAudit.map.project([-120, 35]);
    return { x: point.x, y: point.y };
  });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y);
  await expectSnap(page, true);
  // Keep the entire new gesture inside the suppression timer, regardless of CI speed.
  const now = Date.now();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now + 60_000);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.mouse.click(airport.x, airport.y);
  await expect(page.getByLabel('Selection')).toHaveText('airport: KSBA airport');
  await expect(page.getByLabel('Edits')).toHaveText('0');
});

test('continuous leg movement leaves the full route source alone and only uploads two preview features', async ({ page }) => {
  const { start } = await positions(page);
  await page.evaluate(() => {
    const writes: Array<{ source: string; features: number }> = [];
    Object.assign(window, { routeDragWrites: writes });
    for (const id of ['route-plan', 'route-drag', 'route-alternatives']) {
      const source = window.routeMapAudit.map.getSource(id) as GeoJSONSource;
      const original = source.setData.bind(source);
      source.setData = (data, ...options) => {
        writes.push({ source: id, features: typeof data === 'object' && data.type === 'FeatureCollection' ? data.features.length : -1 });
        return original(data, ...options);
      };
    }
  });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let i = 0; i < 50; i++) await page.mouse.move(start.x + 30 + i, start.y + 50);
  await expectSnap(page, false);
  const writes = await page.evaluate(() => window.routeDragWrites);
  expect(writes.filter(write => write.source === 'route-plan')).toHaveLength(0);
  expect(writes.filter(write => write.source === 'route-alternatives')).toHaveLength(0);
  const previews = writes.filter(write => write.source === 'route-drag');
  expect(previews.length).toBeGreaterThan(0);
  expect(previews.length).toBeLessThanOrEqual(50); // Initial tile loading coalesces pointer moves.
  expect(previews.every(write => write.features === 2)).toBe(true);
  await page.waitForFunction(() => {
    const map = window.routeMapAudit.map;
    const original = map.queryRenderedFeatures({ layers: ['route-line'] });
    return map.getGlobalState()['zlayer-route-drag-visible'] === true &&
      map.queryRenderedFeatures({ layers: ['route-line-drag'] }).length > 0 &&
      original.length > 0 && original.every(feature => map.getFeatureState(feature).dragging === true) &&
      map.queryRenderedFeatures({ layers: ['route-waypoints'] }).length > 0;
  });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.waitForFunction(() => {
    const map = window.routeMapAudit.map;
    const original = map.queryRenderedFeatures({ layers: ['route-line'] });
    return map.getGlobalState()['zlayer-route-drag-visible'] === false &&
      original.length > 0 && original.every(feature => !map.getFeatureState(feature).dragging);
  });
  await expect(page.getByLabel('Edits')).toHaveText('0');
  await expect(page.getByRole('alert')).toBeEmpty();
});

test('a free bend follows individual pixels at high zoom without rounding the preview to GPS tokens', async ({ page }) => {
  await positions(page);
  await page.evaluate(() => window.routeMapAudit.map.jumpTo({ center: [-119, 35], zoom: 13 }));
  await page.waitForFunction(() => window.routeMapAudit.map.loaded() &&
    window.routeMapAudit.map.queryRenderedFeatures({ layers: ['route-leg-hits'] }).length > 0);
  const start = await page.evaluate(() => {
    const point = window.routeMapAudit.map.project([-119, 35]);
    return { x: Math.round(point.x), y: Math.round(point.y) };
  });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let i = 0; i < 5; i++) {
    const point = { x: start.x + 40 + i, y: start.y + 20 };
    await page.mouse.move(point.x, point.y);
    await page.waitForFunction(async point => {
      const map = window.routeMapAudit.map;
      const data = await (map.getSource('route-drag') as GeoJSONSource).getData();
      const marker = data.type === 'FeatureCollection' && data.features.find(feature => feature.properties?.routeKind === 'insert-preview');
      const expected = map.unproject([point.x, point.y]).toArray();
      const actual = marker && marker.geometry.type === 'Point' ? marker.geometry.coordinates : undefined;
      return actual?.[0] === expected[0] && actual?.[1] === expected[1];
    }, point);
  }
  await expectSnap(page, false);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.getByLabel('Edits')).toHaveText('0');
  await expect(page.getByRole('alert')).toBeEmpty();
});

for (const cancel of ['Escape', 'blur', 'outside'] as const) {
  test(`${cancel} cancels a snapped map edit and leaves the next gesture usable`, async ({ page }) => {
    const { start, target } = await positions(page);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y);
    await expectSnap(page, true);
    if (cancel === 'Escape') await page.keyboard.press('Escape');
    else if (cancel === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    else await page.mouse.move(-10, target.y);
    await page.mouse.up();
    await expect(page.getByLabel('Edits')).toHaveText('0');
    await expect(page.getByLabel('Route', { exact: true })).toHaveText('KSBA KSMX');
    await page.waitForFunction(() => {
      const map = window.routeMapAudit.map;
      return map.dragPan.isEnabled() && map.touchZoomRotate.isEnabled() &&
        !map.queryRenderedFeatures({ layers: ['route-insert-preview'] }).length;
    });
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y);
    await expectSnap(page, true);
    await page.mouse.up();
    await expect(page.getByLabel('Edits')).toHaveText('1');
    await expect(page.getByLabel('Route', { exact: true })).toHaveText('KSBA TAILS KSMX');
    await expect(page.getByRole('alert')).toBeEmpty();
  });
}
