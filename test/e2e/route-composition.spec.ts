import { test, expect, type Page } from '@playwright/test';

test.use({ hasTouch: true });

async function openRoute(page: Page, text: string) {
  await page.addInitScript(text => localStorage.setItem('zlayer-plugin:routes:draft', JSON.stringify({ version: 2,
    entries: text.split(' ').map((text, index) => ({ id: `entry-${index}`, text })),
  })), text);
  await page.goto('/test/browser/routes.html?composition');
}

for (const width of [360, 1280]) {
  test(`TEC composition preserves published components and nested airway details at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await openRoute(page, 'KSFO BAYT1 KSJC');
    const before = await page.evaluate(() => localStorage.getItem('zlayer-plugin:routes:draft'));
    const token = page.locator('.route-token').filter({ hasText: 'BAYT1' });
    if (width < 600) await token.tap(); else await token.click();
    const action = page.getByRole('menuitem', { name: 'Show composition', exact: true });
    await expect(action).toBeFocused();
    await action.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'BAYT1 composition' });
    await expect(dialog.getByRole('region', { name: 'Published TEC route' })).toContainText('VECTORS SUNOL V23 EXIT');
    await expect(dialog.locator('ol li')).toHaveText(['VECTORS vector', 'SUNOL fix', 'V23 airway', 'EXIT fix']);
    await expect(dialog.getByRole('region', { name: 'V23 airway' })).toContainText('SUNOL → MID → EXIT');
    await expect(dialog.getByRole('region', { name: 'Composition issues' })).toContainText('VECTORS');
    await expect(dialog.getByRole('button', { name: 'Close route composition' })).toBeFocused();
    await page.evaluate(() => window.dispatchEvent(new Event('route-fixture-refresh')));
    await expect(dialog).toBeVisible();
    const bounds = (await dialog.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
    await dialog.screenshot({ path: testInfo.outputPath('composition.png') });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(token).toBeFocused();
    expect(await page.evaluate(() => localStorage.getItem('zlayer-plugin:routes:draft'))).toBe(before);
  });
}

test('repeated airway names show the selected occurrence and direction; details follow route edits', async ({ page }) => {
  await openRoute(page, 'SUNOL V23 EXIT V23 SUNOL');
  const tokens = page.locator('.route-token');
  for (const [index, path] of [[1, 'SUNOL → MID → EXIT'], [3, 'EXIT → MID → SUNOL']] as const) {
    await tokens.nth(index).click();
    await page.getByRole('menuitem', { name: 'Show composition' }).click();
    const dialog = page.getByRole('dialog', { name: 'V23 composition' });
    await expect(dialog).toContainText(path);
    await dialog.getByRole('button', { name: 'Close route composition' }).click();
    await expect(tokens.nth(index)).toBeFocused();
  }
  await tokens.nth(3).click();
  await page.getByRole('menuitem', { name: 'Show composition' }).click();
  // Opening another control dismisses details without stealing its focus.
  await page.getByRole('button', { name: 'Route actions', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Clear Route', exact: true }).click();
  await expect(tokens).toHaveCount(0);
});

test('SID composition retains shared-branch and discontinuity explanations after airport attachment', async ({ page }) => {
  await openRoute(page, 'KSFO BAY1 SUNOL KSJC');
  const airport = page.locator('.route-token').filter({ hasText: 'KSFO' });
  await expect(page.locator('.route-token')).toHaveCount(3);
  await airport.click();
  await page.getByRole('menuitem', { name: 'Show composition' }).click();
  const dialog = page.getByRole('dialog', { name: 'KSFO composition' });
  await expect(dialog).toContainText('BAY1 · SID');
  await expect(dialog).toContainText('MID · [route discontinuity] · SUNOL');
  await expect(dialog).toContainText('Only the shared waypoint route is available');
});

test('unavailable airways explain the failure; ordinary waypoints do not offer composition', async ({ page }) => {
  await openRoute(page, 'SUNOL V99 EXIT');
  await page.locator('.route-token').nth(1).click();
  await page.getByRole('menuitem', { name: 'Show composition' }).click();
  const dialog = page.getByRole('dialog', { name: 'V99 composition' });
  await expect(dialog).toContainText('Composition is unavailable for this route item.');
  await expect(dialog.getByRole('region', { name: 'Composition issues' })).toContainText('V99');
  await dialog.getByRole('button', { name: 'Close route composition' }).click();
  await page.locator('.route-token').first().click();
  await expect(page.getByRole('menuitem', { name: 'Show composition' })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'Add waypoint before', exact: true })).toBeFocused();
});
