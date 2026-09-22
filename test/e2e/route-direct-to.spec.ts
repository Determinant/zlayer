import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { countWatches, mockGps, sendFix } from './ownship-fixture';
import published from '../fixtures/route-approach-published.json' with { type: 'json' };

test.use({ hasTouch: true });

for (const [width, mode] of [[390, 'map'], [1280, 'map'], [390, 'legacy selection'], [1280, 'missing final fix']] as const)
test(`approach Direct to at ${width}px (${mode})`, async ({ page, request }, testInfo) => {
  await request.post(`/__test/published-approaches${mode === 'missing final fix' ? '-missing-final-fix' : ''}`);
  try {
    await page.setViewportSize({ width, height: 900 });
    await page.clock.setFixedTime(new Date('2026-09-20T23:00:00Z'));
    await mockGps(page);
    const airport = published.airports.find(airport => airport.id === 'KSNS')!;
    const procedure = airport.procedures.find(procedure => procedure.name === 'ILS RWY 31')!;
    const coded = published.terminal.approaches.procedures.find(procedure => procedure.id === 'KSNS:I31')!;
    const target = coded.final.find(leg => leg.fix?.ident === 'FREZZ')!.fix!.coordinate;
    await page.addInitScript(({ procedure, target, mode }) => {
      if (localStorage.getItem('zlayer-plugin:routes:draft')) return;
      localStorage.setItem('zlayers-map-preferences-v1', JSON.stringify({ version: 2, chartBase: '', ownshipEnabled: true }));
      localStorage.setItem('zlayers-map-view-v1', JSON.stringify({ version: 1, center: target, zoom: 11, bearing: 0, pitch: 0 }));
      localStorage.setItem('zlayer-plugin:routes:draft', JSON.stringify({ version: 2, entries: [
        { id: 'origin', text: 'KSMO' },
        { id: 'destination', text: 'KSNS', approach: { airportId: 'KSNS', procedureId: procedure.id,
          name: procedure.name, cycle: '2609', entry: { routeId: 'KSNS:I31', transitionId: 'transition-fix:SNS2:1',
            name: 'ARTYY', effectiveDate: '2026-09-03' } } },
      ] }));
      if (mode === 'legacy selection') {
        localStorage.setItem('zlayer-ui:selected-feature', JSON.stringify({ version: 1, value: {
          type: 'Feature', id: 'approach:destination:2:FREZZ', properties: { ident: 'FREZZ', name: 'FREZZ' },
          geometry: { type: 'Point', coordinates: target.map(value => Math.round(value * 10000) / 10000) },
        } }));
      }
    }, { procedure, target, mode });
    await page.goto('/');
    const bundle = page.locator('.route-attached-approach');
    await expect(bundle).toHaveText('ILS 31 · ARTYY');
    await expect(page.locator('.route-token').last()).toHaveClass(/is-airports/);
    const hideTerrain = page.getByLabel('Hide terrain toolbox', { exact: true });
    if (mode !== 'legacy selection' && await hideTerrain.isVisible()) await hideTerrain.click();
    const direct = page.getByRole('button', { name: 'Direct to FREZZ', exact: true });
    if (mode === 'legacy selection') {
      await expect(page.getByRole('button', { name: 'Remove approach from KSNS', exact: true })).toBeVisible();
      await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('zlayer-ui:selected-feature')!).value.id))
        .toBe(`approach-fix:${JSON.stringify(['FREZZ', ...target])}`);
      await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('zlayer-ui:selected-route-entry')!).value))
        .toBe('expanded:["destination",2]');
      await page.reload();
      await expect(page.getByRole('button', { name: 'Remove approach from KSNS', exact: true })).toBeVisible();
    } else await expect(async () => {
      const box = (await page.locator('.maplibregl-canvas').boundingBox())!;
      if (width < 640) await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      else await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await expect(page.getByRole('button', { name: 'Remove approach from KSNS', exact: true })).toBeVisible();
    }).toPass();
    await expect(direct).toHaveCount(0);
    await expect.poll(() => countWatches(page)).toBe(1);
    await sendFix(page);
    await expect(direct).toBeVisible();
    expect(await direct.evaluate(button => button.nextElementSibling?.textContent)).toBe('ID');
    await page.clock.setFixedTime(new Date('2026-09-20T23:00:01Z'));
    await sendFix(page, { latitude: 36.5, longitude: -121.5 });
    await direct.click();
    const tokens = page.locator('.route-token strong');
    if (mode === 'missing final fix') {
      const problem = page.getByRole('alertdialog', { name: 'Cannot go direct to FREZZ', exact: true });
      await expect(problem).toContainText('incomplete final approach to KSNS');
      await expect(problem.getByRole('button', { name: 'Direct to', exact: true })).toHaveCount(0);
      await expect(tokens).toHaveText(['KSMO', 'KSNS']);
      await expect(bundle).toHaveText('ILS 31 · ARTYY');
      await problem.getByRole('button', { name: 'Close', exact: true }).click();
      return;
    }
    const expected = ['36°30′N 121°30′W', 'FREZZ', 'DEBBS', 'RW31', 'KSNS'];
    await expect(tokens).toHaveText(expected);
    await expect(bundle).toHaveCount(0);
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(page.locator('.route-token.is-error')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('approach-direct-to.png') });
    await page.reload();
    await expect(tokens).toHaveText(expected);
    await expect(bundle).toHaveCount(0);
    await expect(page.locator('.route-token').nth(1)).toHaveClass(/is-fixes/);
    await expect(page.locator('.route-token.is-error')).toHaveCount(0);
  } finally { await request.post('/__test/reset'); }
});

async function openWaypointMenu(token: Locator, touch: boolean) {
  if (!touch) { await token.click({ button: 'right' }); return; }
  await token.tap();
}

for (const touch of [false, true]) {
  test(`Direct to uses the selected occurrence and latest fix via ${touch ? 'tap' : 'right click'}`, async ({ page }, testInfo) => {
    if (touch) await page.setViewportSize({ width: 390, height: 844 });
    await mockGps(page);
    await page.goto('/test/browser/routes.html?gps');
    await expect.poll(() => countWatches(page)).toBe(1);
    const tokens = page.locator('.route-token');
    const direct = page.getByRole('menuitem', { name: 'Direct to', exact: true });
    await openWaypointMenu(tokens.first(), touch);
    await expect(direct).toHaveCount(0);
    await sendFix(page);
    await expect(direct).toBeVisible();
    await page.keyboard.press('Escape');
    await openWaypointMenu(tokens.nth(1), touch);
    await expect(direct).toHaveCount(0); // UNKNOWN has no navigable target.
    await page.keyboard.press('Escape');
    await page.getByRole('textbox', { name: 'Add route waypoint', exact: true }).fill('KSFO KSJC');
    await openWaypointMenu(tokens.nth(3), touch);
    await expect(direct).toBeVisible();
    await page.locator('.route-token-menu').screenshot({ path: testInfo.outputPath('direct-to-menu.png') });
    await sendFix(page, { latitude: 38, longitude: -123 });
    await direct.click();
    await expect(tokens.locator('strong')).toHaveText(['38°00′N 123°00′W', 'KSFO', 'KSJC']);
    await expect(page.getByRole('textbox', { name: 'Add route waypoint', exact: true })).toBeFocused();
    await sendFix(page, { latitude: 39, longitude: -124 });
    await expect(tokens.locator('strong')).toHaveText(['38°00′N 123°00′W', 'KSFO', 'KSJC']);
    await openWaypointMenu(tokens.last(), touch);
    await expect(direct).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('test-gps-error', { detail: 2 })));
    await expect(direct).toHaveCount(0);
  });
}

test('Direct to is keyboard accessible from the waypoint context menu', async ({ page }) => {
  await mockGps(page);
  await page.goto('/test/browser/routes.html?gps');
  await expect.poll(() => countWatches(page)).toBe(1);
  await sendFix(page);
  await page.locator('.route-token').last().focus();
  await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menuitem', { name: 'Direct to', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.route-token strong')).toHaveText(['37°00′N 122°00′W', 'KSJC']);
});

async function restoreFeature(page: Page, ident: string, coordinates: [number, number]) {
  await mockGps(page);
  await page.addInitScript(({ ident, coordinates }) => {
    if (localStorage.getItem('zlayer-plugin:routes:draft')) return;
    localStorage.setItem('zlayers-map-preferences-v1', JSON.stringify({ version: 2, chartBase: '', ownshipEnabled: true }));
    localStorage.setItem('zlayer-plugin:routes:draft', JSON.stringify({ version: 2, entries: [
      { id: 'first', text: '340000N1180000W' }, { id: 'target', text: '350000N1190000W' },
      { id: 'last', text: '360000N1200000W' },
    ] }));
    localStorage.setItem('zlayer-ui:selected-feature', JSON.stringify({ version: 1, value: {
      type: 'Feature', geometry: { type: 'Point', coordinates },
      properties: { kind: 'coordinate', ident, name: 'GPS waypoint' },
    } }));
  }, { ident, coordinates });
  await page.goto('/');
  await expect(page.getByRole('button', { name: `Identify ${ident} with nearby navaids`, exact: true })).toBeVisible();
  await expect.poll(() => countWatches(page)).toBe(1);
}

test('the entity icon precedes ID, trims the route, and persists the GPS origin on reload', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await restoreFeature(page, '350000N1190000W', [-119, 35]);
  const direct = page.getByRole('button', { name: 'Direct to 350000N1190000W', exact: true });
  await expect(direct).toHaveCount(0);
  await sendFix(page);
  await expect(direct).toBeVisible();
  expect(await direct.evaluate(button => button.nextElementSibling?.textContent)).toBe('ID');
  expect((await direct.boundingBox())!.width).toBeGreaterThanOrEqual(44);
  await page.locator('.feature-card').screenshot({ path: testInfo.outputPath('direct-to-card-phone.png') });
  const dialogs: string[] = [];
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await direct.tap();
  await expect(page.locator('.route-token strong')).toHaveText(['37°00′N 122°00′W', '35°00′N 119°00′W', '36°00′N 120°00′W']);
  expect(dialogs).toEqual([]);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('zlayer-plugin:routes:draft')!).entries[0].text))
    .toBe('370000N1220000W');
  await page.reload();
  await expect(page.locator('.route-token strong')).toHaveText(['37°00′N 122°00′W', '35°00′N 119°00′W', '36°00′N 120°00′W']);
  await expect(direct).toHaveCount(0);
});

for (const width of [320, 1280]) test(`off-route Direct to uses an in-app confirmation at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 844 });
  await restoreFeature(page, '330000N1170000W', [-117, 33]);
  await sendFix(page);
  const direct = page.getByRole('button', { name: 'Direct to 330000N1170000W', exact: true });
  const tokens = page.locator('.route-token strong');
  const dialogs: string[] = [];
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await direct.click();
  const popup = page.getByRole('alertdialog', { name: 'Direct to 330000N1170000W?', exact: true });
  const cancel = popup.getByRole('button', { name: 'Cancel', exact: true });
  const confirm = popup.getByRole('button', { name: 'Direct to', exact: true });
  await expect(popup).toBeVisible();
  await expect(popup).toContainText('clear the current route');
  await expect(cancel).toBeFocused();
  await cancel.press('Shift+Tab');
  await expect(confirm).toBeFocused();
  await confirm.press('Tab');
  await expect(cancel).toBeFocused();
  const box = (await popup.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(16);
  expect(box.x + box.width).toBeLessThanOrEqual(width - 16);
  await popup.screenshot({ path: testInfo.outputPath('direct-to-confirmation.png') });
  await cancel.click();
  await expect(popup).toBeHidden();
  await expect(direct).toBeFocused();
  await expect(tokens).toHaveText(['34°00′N 118°00′W', '35°00′N 119°00′W', '36°00′N 120°00′W']);
  await direct.click();
  await cancel.press('Escape');
  await expect(popup).toBeHidden();
  await expect(direct).toBeFocused();
  await expect(tokens).toHaveText(['34°00′N 118°00′W', '35°00′N 119°00′W', '36°00′N 120°00′W']);
  await direct.click();
  await expect(popup).toBeVisible();
  await sendFix(page, { latitude: 38, longitude: -123 });
  await confirm.click();
  await expect(popup).toBeHidden();
  await expect(tokens).toHaveText(['38°00′N 123°00′W', '33°00′N 117°00′W']);
  expect(dialogs).toEqual([]);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('test-gps-error', { detail: 1 })));
  await expect(direct).toHaveCount(0);
});

test('Direct to confirmation waits for GPS recovery and uses the recovered position', async ({ page }) => {
  await restoreFeature(page, '330000N1170000W', [-117, 33]);
  await sendFix(page);
  await page.getByRole('button', { name: 'Direct to 330000N1170000W', exact: true }).click();
  const popup = page.getByRole('alertdialog', { name: 'Direct to 330000N1170000W?', exact: true });
  const confirm = popup.getByRole('button', { name: 'Direct to', exact: true });
  await expect(confirm).toBeEnabled();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('test-gps-error', { detail: 2 })));
  await expect(confirm).toBeDisabled();
  await expect(popup.getByRole('status')).toHaveText('Waiting for a fresh GPS fix.');
  await expect(page.locator('.route-token strong')).toHaveText(['34°00′N 118°00′W', '35°00′N 119°00′W', '36°00′N 120°00′W']);
  await sendFix(page, { latitude: 38, longitude: -123 });
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(popup).toBeHidden();
  await expect(page.locator('.route-token strong')).toHaveText(['38°00′N 123°00′W', '33°00′N 117°00′W']);
});

test('an expanded airway waypoint on the map directs to its remaining path', async ({ page }) => {
  await mockGps(page);
  await page.goto('/test/browser/route-map.html?details&gps&route=KSBA+ENTRY+V1+EXIT+KSMX');
  await expect.poll(() => countWatches(page)).toBe(1);
  await sendFix(page);
  await page.waitForFunction(() => {
    const map = (window as unknown as { routeMapAudit?: { map: MapLibreMap } }).routeMapAudit?.map;
    return map?.getLayer('route-waypoints') && map.queryRenderedFeatures({ layers: ['route-waypoints'] })
      .some(feature => feature.properties.ident === 'TAILS');
  });
  const target = await page.evaluate(() => {
    const map = (window as unknown as { routeMapAudit: { map: MapLibreMap } }).routeMapAudit.map;
    const { x, y } = map.project([-119, 36]);
    return { x, y };
  });
  await page.mouse.click(target.x, target.y);
  const direct = page.getByRole('button', { name: 'Direct to TAILS', exact: true });
  await expect(direct).toBeVisible();
  await direct.click();
  await expect(page.getByLabel('Route', { exact: true })).toHaveText('370000N1220000W TAILS MID EXIT KSMX');
  await expect(page.getByRole('alert')).toBeEmpty();
});

for (const [route, problem, message] of [
  ['KSBA ENTRY V1 EXIT KSMX', 'missingFix=MID', 'required point MID is unavailable'],
  ['KSBA ENTRY ARR1 KSMX', 'procedureGapAfter=TAILS', 'published route discontinuity'],
  ['KSBA ENTRY ARR1 KSMX', '', 'connect EXIT to KSMX across a route discontinuity'],
] as const) test(`Direct to preserves ${route} when it cannot preserve the remainder (${problem || 'airport gap'})`, async ({ page }) => {
  await mockGps(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/test/browser/route-map.html?details&gps&route=${encodeURIComponent(route)}&${problem}`);
  await expect.poll(() => countWatches(page)).toBe(1);
  await sendFix(page);
  await page.waitForFunction(() => {
    const map = (window as unknown as { routeMapAudit?: { map: MapLibreMap } }).routeMapAudit?.map;
    return map?.getLayer('route-waypoints') && map.queryRenderedFeatures({ layers: ['route-waypoints'] })
      .some(feature => feature.properties.ident === 'TAILS');
  });
  const target = await page.evaluate(() => {
    const map = (window as unknown as { routeMapAudit: { map: MapLibreMap } }).routeMapAudit.map;
    const { x, y } = map.project([-119, 36]);
    return { x, y };
  });
  await page.touchscreen.tap(target.x, target.y);
  const direct = page.getByRole('button', { name: 'Direct to TAILS', exact: true });
  await direct.tap();
  const dialog = page.getByRole('alertdialog', { name: 'Cannot go direct to TAILS', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(message);
  await expect(dialog).toContainText('Your route has not changed.');
  await expect(dialog.getByRole('button', { name: 'Direct to', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
  await expect(page.getByLabel('Route', { exact: true })).toHaveText(route);
  await expect(page.getByLabel('Edits', { exact: true })).toHaveText('0');
  await dialog.getByRole('button', { name: 'Close', exact: true }).press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByLabel('Route', { exact: true })).toHaveText(route);
});
