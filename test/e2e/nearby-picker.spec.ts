import { expect, test } from '@playwright/test';
import type { Map as MapLibreMap } from 'maplibre-gl';

test.use({ hasTouch: true });

for (const touch of [false, true]) {
  test(`nearby route points can be selected and removed (${touch ? 'touch' : 'mouse'})`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: touch ? 320 : 1280, height: touch ? 568 : 900 });
    await page.goto('/test/browser/route-map.html?details&route=KSBA%20350000N1190000W%20KSMX');
    await page.waitForFunction(() => {
      const map = (window as unknown as { routeMapAudit?: { map: MapLibreMap } }).routeMapAudit?.map;
      return map?.getLayer('route-waypoints') && map.queryRenderedFeatures({ layers: ['route-waypoints'] }).length === 3;
    });
    const point = await page.evaluate(() => {
      const map = (window as unknown as { routeMapAudit: { map: MapLibreMap } }).routeMapAudit.map;
      // Planned points must be available even without visible symbols or labels.
      map.setLayoutProperty('route-waypoints', 'visibility', 'none');
      map.setLayoutProperty('route-waypoint-labels', 'visibility', 'none');
      const point = map.project([-119, 35]);
      return { x: point.x, y: point.y };
    });
    const session = touch ? await page.context().newCDPSession(page) : undefined;
    if (session) await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    else await page.mouse.click(point.x, point.y, { button: 'right' });
    const chooser = page.getByRole('dialog', { name: 'Nearby map features' });
    await expect(chooser).toBeVisible();
    if (session) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await session.detach();
    }
    await chooser.getByRole('button', { name: /350000N1190000W.*On route · point 2/ }).click();
    await expect(chooser).toHaveCount(0);
    const card = page.locator('.feature-card');
    const remove = card.getByRole('button', { name: 'Remove 350000N1190000W from route', exact: true });
    const append = card.getByRole('button', { name: 'Add 350000N1190000W to end of route', exact: true });
    await expect(remove).toBeVisible();
    await expect(remove).toHaveCSS('color', 'rgb(242, 160, 154)');
    expect((await remove.boundingBox())!.x).toBeLessThan((await append.boundingBox())!.x);
    expect((await remove.boundingBox())!.width).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await card.screenshot({ path: testInfo.outputPath('route-point-actions.png') });
    await remove.click();
    await expect(page.getByLabel('Route', { exact: true })).toHaveText('KSBA KSMX');
    await expect(remove).toHaveCount(0);
    await expect(append).toBeVisible();
    await expect(page.getByLabel('Edits')).toHaveText('1');
    await append.click();
    await expect(remove).toBeVisible();
    await expect(page.locator('.feature-card')).toHaveCount(1);
    await expect(page.getByLabel('Route', { exact: true })).toHaveText('KSBA KSMX 350000N1190000W');
  });
}

for (const touch of [false, true]) {
  test(`a named route fix has a red remove action after map selection (${touch ? 'touch' : 'mouse'})`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: touch ? 320 : 1280, height: touch ? 568 : 900 });
    await page.goto('/test/browser/route-map.html?details&route=KSBA%20TAILS%20KSMX');
    await page.waitForFunction(() => {
      const map = (window as unknown as { routeMapAudit?: { map: MapLibreMap } }).routeMapAudit?.map;
      return map?.getLayer('route-waypoints') && map.queryRenderedFeatures({ layers: ['route-waypoints'] })
        .some(feature => feature.properties.ident === 'TAILS');
    });
    const point = await page.evaluate(() => {
      const point = (window as unknown as { routeMapAudit: { map: MapLibreMap } }).routeMapAudit.map.project([-119, 36]);
      return { x: point.x, y: point.y };
    });
    if (touch) await page.touchscreen.tap(point.x, point.y);
    else await page.mouse.click(point.x, point.y);
    const remove = page.getByRole('button', { name: 'Remove TAILS from route', exact: true });
    await expect(remove).toBeVisible();
    await expect(remove).toHaveCSS('color', 'rgb(242, 160, 154)');
    await page.locator('.feature-card').screenshot({ path: testInfo.outputPath('named-fix-actions.png') });
    await remove.click();
    await expect(page.getByLabel('Route', { exact: true })).toHaveText('KSBA KSMX');
    await expect(remove).toHaveCount(0);
    await expect(page.getByLabel('Edits')).toHaveText('1');
  });
}

test('nearby duplicate waypoints remove only the selected route occurrence', async ({ page }) => {
  await page.goto('/test/browser/route-map.html?details&route=KSBA%20350000N1190000W%20KSMX%20350000N1190000W');
  await page.waitForFunction(() => {
    const map = (window as unknown as { routeMapAudit?: { map: MapLibreMap } }).routeMapAudit?.map;
    return map?.getLayer('route-waypoints') && map.queryRenderedFeatures({ layers: ['route-waypoints'] }).length > 0;
  });
  const point = await page.evaluate(() => {
    const point = (window as unknown as { routeMapAudit: { map: MapLibreMap } }).routeMapAudit.map.project([-119, 35]);
    return { x: point.x, y: point.y };
  });
  await page.mouse.click(point.x, point.y, { button: 'right' });
  const chooser = page.getByRole('dialog', { name: 'Nearby map features' });
  await expect(chooser.getByRole('button', { name: /350000N1190000W/ })).toHaveCount(2);
  await chooser.getByRole('button', { name: /On route · point 4/ }).click();
  await page.getByRole('button', { name: 'Remove 350000N1190000W from route', exact: true }).click();
  await expect(page.getByLabel('Route', { exact: true })).toHaveText('KSBA 350000N1190000W KSMX');
  await expect(page.getByRole('button', { name: 'Remove 350000N1190000W from route', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Remove 350000N1190000W from route', exact: true }).click();
  await expect(page.getByLabel('Route', { exact: true })).toHaveText('KSBA KSMX');
  await expect(page.getByRole('button', { name: 'Remove 350000N1190000W from route', exact: true })).toHaveCount(0);
});

for (const touch of [false, true]) {
  test(`departure, destination and the final remaining airport all have red remove actions (${touch ? 'touch' : 'mouse'})`, async ({ page }) => {
    await page.setViewportSize({ width: touch ? 320 : 1280, height: touch ? 568 : 900 });
    await page.goto('/test/browser/route-map.html?details&route=KSBA%20KSMX%20KSBA');
    for (const [ident, longitude, position, remaining] of [
      ['KSBA', -120, 3, 'KSBA KSMX'],
      ['KSBA', -120, 1, 'KSMX'],
      ['KSMX', -118, 1, ''],
    ] as const) {
      await page.waitForFunction(ident => {
        const map = (window as unknown as { routeMapAudit?: { map: MapLibreMap } }).routeMapAudit?.map;
        return map?.getLayer('route-waypoints') && map.queryRenderedFeatures({ layers: ['route-waypoints'] })
          .some(feature => feature.properties.ident === ident);
      }, ident);
      const point = await page.evaluate(longitude => {
        const point = (window as unknown as { routeMapAudit: { map: MapLibreMap } }).routeMapAudit.map.project([longitude, 35]);
        return { x: point.x, y: point.y };
      }, longitude);
      const session = touch ? await page.context().newCDPSession(page) : undefined;
      if (session) await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
      else await page.mouse.click(point.x, point.y, { button: 'right' });
      const chooser = page.getByRole('dialog', { name: 'Nearby map features' });
      await expect(chooser).toBeVisible();
      if (session) {
        await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await session.detach();
      }
      await chooser.getByRole('button', { name: new RegExp(`${ident}.*On route · point ${position}`) }).click();
      const remove = page.getByRole('button', { name: `Remove ${ident} from route`, exact: true });
      await expect(remove).toBeVisible();
      await expect(remove).toHaveCSS('color', 'rgb(242, 160, 154)');
      await remove.click();
      await expect(page.getByLabel('Route', { exact: true })).toHaveText(remaining);
      if (remaining.includes(ident)) await expect(remove).toBeVisible();
      else await expect(remove).toHaveCount(0);
      await page.getByRole('button', { name: 'Close detail', exact: true }).click();
    }
    await expect(page.getByLabel('Edits')).toHaveText('3');
  });
}

test('the app detail panel can remove a navigation waypoint added through search', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Search FAA navigation data').fill('CMA');
  await page.locator('.search-results button').filter({ hasText: 'CMA' }).click();
  const append = page.getByRole('button', { name: 'Add CMA to end of route', exact: true });
  const remove = page.getByRole('button', { name: 'Remove CMA from route', exact: true });
  await expect(remove).toHaveCount(0);
  await append.click();
  await expect(page.locator('.route-token strong')).toHaveText(['CMA']);
  await expect(remove).toBeVisible();
  const originalPanel = await page.locator('.feature-card').elementHandle();
  await append.click();
  await expect(page.locator('.route-token strong')).toHaveText(['CMA', 'CMA']);
  await remove.click();
  await expect(page.locator('.route-token strong')).toHaveText(['CMA']);
  await expect(remove).toBeVisible();
  await remove.click();
  await expect(page.locator('.route-token')).toHaveCount(0);
  await expect(remove).toHaveCount(0);
  await expect(append).toBeVisible();
  expect(await page.locator('.feature-card').evaluate((card, original) => card === original, originalPanel)).toBe(true);
  await expect(page.locator('.feature-card')).toHaveCount(1);
});

test('a restored detail panel retains the selected occurrence of a repeated GPS waypoint', async ({ page }) => {
  await page.addInitScript(() => {
    if (localStorage.getItem('zlayer-route-draft-v1')) return;
    localStorage.setItem('zlayer-route-draft-v1', JSON.stringify({ version: 2, entries: [
      { id: 'first', text: '350000N1190000W' }, { id: 'middle', text: '360000N1200000W' },
      { id: 'last', text: '350000N1190000W' },
    ] }));
    localStorage.setItem('zlayer-ui:selected-feature', JSON.stringify({ version: 1, value: {
      type: 'Feature', geometry: { type: 'Point', coordinates: [-119, 35] },
      properties: { kind: 'coordinate', ident: '350000N1190000W', name: 'GPS waypoint' },
    } }));
    localStorage.setItem('zlayer-ui:selected-route-entry', JSON.stringify({ version: 1, value: 'last' }));
  });
  await page.goto('/');
  const remove = page.getByRole('button', { name: 'Remove 350000N1190000W from route', exact: true });
  await expect(remove).toBeVisible();
  await page.reload();
  await remove.click();
  await expect(page.locator('.route-token strong')).toHaveText(['350000N1190000W', '360000N1200000W']);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('zlayer-route-draft-v1')!).entries
    .map((entry: { id: string }) => entry.id))).toEqual(['first', 'middle']);
  await page.reload();
  await expect(page.locator('.route-token')).toHaveCount(2);
  await expect(remove).toBeVisible();
  await remove.click();
  await expect(page.locator('.route-token strong')).toHaveText(['360000N1200000W']);
  await expect(remove).toHaveCount(0);
});

for (const touch of [false, true]) for (const [input, item, pointOnly, wholeItem] of [
  ['KSBA ENTRY V1 EXIT KSMX', 'V1', 'KSBA ENTRY MID EXIT KSMX', 'KSBA ENTRY EXIT KSMX'],
  ['KSBA DEP1 EXIT KSMX', 'DEP1', 'KSBA ENTRY MID EXIT KSMX', 'KSBA EXIT KSMX'],
  ['KSBA TEST1 KSMX', 'TEST1', 'KSBA ENTRY MID EXIT KSMX', 'KSBA KSMX'],
] as const) {
  test(`the same detail panel offers both removals for ${item} (${touch ? 'touch' : 'mouse'})`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: touch ? 320 : 1280, height: touch ? 568 : 900 });
    for (const whole of [false, true]) {
      await page.goto(`/test/browser/route-map.html?details&route=${encodeURIComponent(input)}`);
      await page.waitForFunction(() => {
        const map = (window as unknown as { routeMapAudit?: { map: MapLibreMap } }).routeMapAudit?.map;
        return map?.getLayer('route-waypoints') && map.queryRenderedFeatures({ layers: ['route-waypoints'] })
          .some(feature => feature.properties.ident === 'TAILS');
      });
      const point = await page.evaluate(() => {
        const point = (window as unknown as { routeMapAudit: { map: MapLibreMap } }).routeMapAudit.map.project([-119, 36]);
        return { x: point.x, y: point.y };
      });
      if (touch) await page.touchscreen.tap(point.x, point.y);
      else await page.mouse.click(point.x, point.y);
      const card = page.locator('.feature-card');
      await expect(card).toHaveCount(1);
      const remove = card.getByRole('button', { name: 'Remove TAILS from route', exact: true });
      await expect(remove).toBeVisible();
      await expect(remove).toHaveCSS('color', 'rgb(242, 160, 154)');
      await remove.click();
      const only = card.getByRole('menuitem', { name: /Remove only TAILS/ });
      const entire = card.getByRole('menuitem', { name: `Remove entire ${item} route item`, exact: true });
      await expect(only).toBeVisible();
      await expect(entire).toBeVisible();
      await expect(only).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(entire).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(card.getByRole('menu')).toHaveCount(0);
      await expect(remove).toBeFocused();
      await remove.click();
      await card.screenshot({ path: testInfo.outputPath(`removal-choices-${whole ? 'item' : 'point'}.png`) });
      await (whole ? entire : only).click();
      await expect(page.getByLabel('Route', { exact: true })).toHaveText(whole ? wholeItem : pointOnly);
      await expect(remove).toHaveCount(0);
      await expect(card).toHaveCount(1);
      await expect(card.getByRole('heading', { name: 'TAILS', exact: true })).toBeVisible();
      await expect(card.getByRole('button', { name: 'Add TAILS to end of route', exact: true })).toBeVisible();
      await expect(page.getByLabel('Edits')).toHaveText('1');
    }
  });
}

for (const [width, height] of [[320, 568], [568, 320], [744, 1133]] as const) {
  test(`nearby chooser stays inside the map when opened at its edge (${width}×${height})`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/test/browser/route-map.html');
    await page.waitForFunction(() => Boolean((window as unknown as { routeMapAudit?: unknown }).routeMapAudit));
    await page.evaluate(({ width, height }) => {
      const audit = (window as unknown as { routeMapAudit: { showNearby: (point: { x: number; y: number }) => void } }).routeMapAudit;
      audit.showNearby({ x: width - 8, y: height - 8 });
    }, { width, height });
    const chooser = page.getByRole('dialog', { name: 'Nearby map features' });
    await expect(chooser).toBeVisible();
    await expect(chooser.getByRole('button', { name: /KSBA/ })).toBeFocused();
    const bounds = (await chooser.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(12);
    expect(bounds.y).toBeGreaterThanOrEqual(12);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width - 11);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(height - 11);
    await page.setViewportSize({ width: 320, height: 400 });
    await expect.poll(async () => {
      const box = (await chooser.boundingBox())!;
      return box.x + box.width <= 309 && box.y + box.height <= 389;
    }).toBe(true);
    await chooser.getByRole('button', { name: /KSBA/ }).click();
    await expect(page.getByLabel('Selection')).toContainText('KSBA airport');
  });
}

test('nearby dialog supports Tab and returns focus on Escape', async ({ page }) => {
  await page.goto('/test/browser/route-map.html');
  await page.waitForFunction(() => Boolean((window as unknown as { routeMapAudit?: unknown }).routeMapAudit));
  await page.evaluate(() => {
    const trigger = document.createElement('button');
    trigger.textContent = 'Map trigger';
    document.body.append(trigger);
    trigger.focus();
    (window as unknown as { routeMapAudit: { showNearby: (point: { x: number; y: number }) => void } })
      .routeMapAudit.showNearby({ x: 100, y: 100 });
  });
  const chooser = page.getByRole('dialog', { name: 'Nearby map features' });
  await expect(chooser.getByRole('button', { name: /KSBA/ })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(chooser.getByRole('button', { name: /KSMX/ })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(chooser).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Map trigger' })).toBeFocused();
});
