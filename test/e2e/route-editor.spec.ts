import { test, expect, type Locator, type Page } from '@playwright/test';

test.use({ hasTouch: true });

async function replaceItem(page: Page, token: Locator, touch = false) {
  if (touch) {
    await token.tap();
  } else {
    await token.click({ button: 'right' });
  }
  await page.getByRole('menuitem', { name: 'Replace route item', exact: true }).click();
  return page.getByRole('textbox', { name: /^Replace route item / });
}

for (const width of [320, 360, 390, 430, 480, 600, 601, 744, 832, 1280]) {
  test(`replace a route item in place at ${width}px, preserving the edit through a data refresh`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/test/browser/routes.html');
    const tokens = page.locator('.route-token');
    await expect(tokens).toHaveCount(3);
    for (const token of await tokens.all()) {
      expect((await token.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      expect(await token.evaluate(element => parseFloat(getComputedStyle(element, '::before').height))).toBeLessThan(44);
    }
    const originalIds = await page.locator('[data-route-entry]').evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.routeEntry));
    const editor = page.locator('.route-editor');
    const routeMenu = page.getByRole('button', { name: 'Route actions', exact: true });
    const editorBox = (await editor.boundingBox())!;
    const menuBox = (await routeMenu.boundingBox())!;
    if (width <= 600) {
      expect(editorBox.width).toBe(width - 18);
      expect(menuBox.y).toBeGreaterThanOrEqual(editorBox.y + editorBox.height);
      const adviseBox = (await page.getByRole('button', { name: 'Advise', exact: true }).boundingBox())!;
      expect(adviseBox.y).toBe(menuBox.y);
      expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(adviseBox.x);
    } else {
      expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(editorBox.x);
    }
    expect(menuBox.width).toBeGreaterThanOrEqual(44);
    expect(menuBox.height).toBeGreaterThanOrEqual(44);
    const input = await replaceItem(page, tokens.nth(1), width <= 600);
    await expect(input).toHaveValue('UNKNOWN');
    expect(await input.evaluate(element => {
      const field = element as HTMLInputElement;
      return [field.selectionStart, field.selectionEnd];
    })).toEqual([0, 7]);
    await input.fill('KSJC');
    await page.evaluate(() => window.dispatchEvent(new Event('route-fixture-refresh')));
    await expect(input).toHaveValue('KSJC');
    const inputBox = (await input.boundingBox())!;
    expect(inputBox.x).toBeGreaterThanOrEqual(editorBox.x);
    expect(inputBox.x + inputBox.width).toBeLessThanOrEqual(editorBox.x + editorBox.width);
    await input.click();
    await page.locator('.route-bar').screenshot({ path: testInfo.outputPath('replacement-field.png') });
    await input.press('Enter');
    await expect(tokens.locator('strong')).toHaveText(['KSFO', 'KSJC', 'KSJC']);
    await expect(page.locator('output')).toHaveText('2 legs; 0 issues');
    expect(await page.locator('[data-route-entry]').evaluateAll(elements => elements.map(element => (element as HTMLElement).dataset.routeEntry)))
      .toEqual(originalIds);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // Resizing across the phone breakpoint keeps the in-progress editor mounted.
    if (width === 600) {
      await page.getByRole('textbox', { name: 'Add route waypoint', exact: true }).fill('KS');
      for (const nextWidth of [601, 600]) {
        await page.setViewportSize({ width: nextWidth, height: 844 });
        await expect(page.getByRole('textbox', { name: 'Add route waypoint', exact: true })).toHaveValue('KS');
      }
    }
    await routeMenu.click();
    await page.getByRole('menuitem', { name: 'Clear Route', exact: true }).click();
    await expect(tokens).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Add route waypoint', exact: true })).toHaveValue('');
    await expect(page.getByRole('textbox', { name: 'Add route waypoint', exact: true })).toBeFocused();
  });
}

test('replacement cancels on Escape or empty input, commits on blur, and accepts a pasted segment', async ({ page }) => {
  await page.goto('/test/browser/routes.html');
  const tokens = page.locator('.route-token');
  let input = await replaceItem(page, tokens.nth(1));
  await input.fill('KSFO');
  await input.press('Escape');
  await expect(tokens.locator('strong')).toHaveText(['KSFO', 'UNKNOWN', 'KSJC']);
  input = await replaceItem(page, tokens.nth(1));
  await input.fill('');
  await input.press('Enter');
  await expect(tokens.locator('strong')).toHaveText(['KSFO', 'UNKNOWN', 'KSJC']);
  input = await replaceItem(page, tokens.nth(1));
  await input.fill('KSFO');
  await page.locator('header').click();
  await expect(tokens.locator('strong')).toHaveText(['KSFO', 'KSFO', 'KSJC']);
  input = await replaceItem(page, tokens.nth(1));
  await input.fill('KSJC DCT KSFO');
  await expect(tokens.locator('strong')).toHaveText(['KSFO', 'KSJC', 'KSFO', 'KSJC']);
  await expect(page.locator('output')).toHaveText('3 legs; 0 issues');
  input = await replaceItem(page, tokens.nth(1));
  await input.fill('UNKNOWN');
  await input.press('Enter');
  await expect(tokens.nth(1)).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('output')).toHaveText('1 legs; 1 issues');
  await replaceItem(page, tokens.nth(1));
  await page.getByRole('button', { name: 'Route actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Clear Route', exact: true }).click();
  await expect(tokens).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Add route waypoint', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Add route waypoint', exact: true }).fill('KSFO KSJC');
  await tokens.nth(1).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Add waypoint before', exact: true }).click();
  const insertion = page.getByRole('textbox', { name: 'Add waypoint before KSJC', exact: true });
  await insertion.fill('UNKNOWN');
  await insertion.press('Enter');
  await expect(tokens.locator('strong')).toHaveText(['KSFO', 'UNKNOWN', 'KSJC']);
});
