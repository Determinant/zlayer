import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { countWatches, mockGps, sendFix } from './ownship-fixture';

test.use({ hasTouch: true });

async function openWaypointMenu(page: Page, token: Locator, touch: boolean) {
  if (!touch) { await token.click({ button: 'right' }); return; }
  await token.scrollIntoViewIfNeeded();
  const box = (await token.boundingBox())!;
  const session = await page.context().newCDPSession(page);
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] });
  await expect(page.getByRole('menuitem', { name: 'Add waypoint before', exact: true })).toBeVisible();
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await session.detach();
}

for (const touch of [false, true]) {
  test(`Direct to uses the selected occurrence and latest fix via ${touch ? 'long press' : 'right click'}`, async ({ page }, testInfo) => {
    if (touch) await page.setViewportSize({ width: 390, height: 844 });
    await mockGps(page);
    await page.goto('/test/browser/routes.html?gps');
    await expect.poll(() => countWatches(page)).toBe(1);
    const tokens = page.locator('.route-token');
    const direct = page.getByRole('menuitem', { name: 'Direct to', exact: true });
    await openWaypointMenu(page, tokens.first(), touch);
    await expect(direct).toHaveCount(0);
    await sendFix(page);
    await expect(direct).toBeVisible();
    await page.keyboard.press('Escape');
    await openWaypointMenu(page, tokens.nth(1), touch);
    await expect(direct).toHaveCount(0); // UNKNOWN has no navigable target.
    await page.keyboard.press('Escape');
    await page.getByRole('textbox', { name: 'Add route waypoint', exact: true }).fill('KSFO KSJC');
    await openWaypointMenu(page, tokens.nth(3), touch);
    await expect(direct).toBeVisible();
    await page.locator('.route-token-menu').screenshot({ path: testInfo.outputPath('direct-to-menu.png') });
    await sendFix(page, { latitude: 38, longitude: -123 });
    await direct.click();
    await expect(tokens.locator('strong')).toHaveText(['380000N1230000W', 'KSFO', 'KSJC']);
    await expect(page.getByRole('textbox', { name: 'Add route waypoint', exact: true })).toBeFocused();
    await sendFix(page, { latitude: 39, longitude: -124 });
    await expect(tokens.locator('strong')).toHaveText(['380000N1230000W', 'KSFO', 'KSJC']);
    await openWaypointMenu(page, tokens.last(), touch);
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
  await expect(page.locator('.route-token strong')).toHaveText(['370000N1220000W', 'KSJC']);
});

async function restoreFeature(page: Page, ident: string, coordinates: [number, number]) {
  await mockGps(page);
  await page.addInitScript(({ ident, coordinates }) => {
    if (localStorage.getItem('zlayer-route-draft-v1')) return;
    localStorage.setItem('zlayers-map-preferences-v1', JSON.stringify({ version: 2, chartBase: '', ownshipEnabled: true }));
    localStorage.setItem('zlayer-route-draft-v1', JSON.stringify({ version: 2, entries: [
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
  await expect(page.locator('.route-token strong')).toHaveText(['370000N1220000W', '350000N1190000W', '360000N1200000W']);
  expect(dialogs).toEqual([]);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('zlayer-route-draft-v1')!).entries[0].text))
    .toBe('370000N1220000W');
  await page.reload();
  await expect(page.locator('.route-token strong')).toHaveText(['370000N1220000W', '350000N1190000W', '360000N1200000W']);
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
  await expect(tokens).toHaveText(['340000N1180000W', '350000N1190000W', '360000N1200000W']);
  await direct.click();
  await cancel.press('Escape');
  await expect(popup).toBeHidden();
  await expect(direct).toBeFocused();
  await expect(tokens).toHaveText(['340000N1180000W', '350000N1190000W', '360000N1200000W']);
  await direct.click();
  await expect(popup).toBeVisible();
  await sendFix(page, { latitude: 38, longitude: -123 });
  await confirm.click();
  await expect(popup).toBeHidden();
  await expect(tokens).toHaveText(['380000N1230000W', '330000N1170000W']);
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
  await expect(page.locator('.route-token strong')).toHaveText(['340000N1180000W', '350000N1190000W', '360000N1200000W']);
  await sendFix(page, { latitude: 38, longitude: -123 });
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(popup).toBeHidden();
  await expect(page.locator('.route-token strong')).toHaveText(['380000N1230000W', '330000N1170000W']);
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
