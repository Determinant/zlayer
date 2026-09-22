import { expect, test } from '@playwright/test';

for (const layout of ['rail', 'compact']) {
  test(`host visibility preserves a fullscreen surface and its contents with ${layout} tabs`, async ({ page }) => {
    await page.goto(`/test/browser/edge-panels.html?layout=${layout}&surface&expanded`);
    const surface = page.locator('.edge-panels.is-right .panel-surface');
    const input = page.getByLabel('right-a value');
    await expect(page.locator('dialog:modal')).toHaveCount(0);
    await page.getByRole('button', { name: 'Open right-a', exact: true }).click();
    await expect(surface).toHaveJSProperty('open', true);
    await expect(page.locator('dialog:modal')).toHaveCount(1);
    await input.fill('Keep this reader state');
    const original = await input.elementHandle();

    // A controlled host selection can hide an expanded panel without changing
    // its saved fullscreen preference (e.g. while restoring workspace state).
    await page.getByRole('button', { name: 'Open right-b', exact: true }).evaluate(button => (button as HTMLButtonElement).click());
    await expect(page.locator('dialog:modal')).toHaveCount(0);
    await expect(surface).toBeHidden();
    await page.getByRole('button', { name: 'Open right-a', exact: true }).click();
    await expect(page.locator('dialog:modal')).toHaveCount(1);
    await expect(input).toHaveValue('Keep this reader state');
    expect(await input.evaluate((element, prior) => element === prior, original)).toBe(true);

    await page.keyboard.press('Escape');
    await expect(page.locator('dialog:modal')).toHaveCount(0);
    await expect(surface).toBeVisible();
    await expect(surface.getByRole('button', { name: 'Enter full screen' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(surface).toBeHidden();
    await expect(page.getByRole('button', { name: 'Show right-a', exact: true })).toBeFocused();
  });

  test(`removing an expanded contribution releases modality and remounts cleanly with ${layout} tabs`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`/test/browser/edge-panels.html?layout=${layout}&surface&expanded`);
    await page.getByRole('button', { name: 'Open right-a', exact: true }).click();
    const surface = page.locator('.edge-panels.is-right .panel-surface');
    await expect(page.locator('dialog:modal')).toHaveCount(1);
    // Simulate host/plugin teardown while its surface is still modal.
    await page.evaluate(() => window.dispatchEvent(new Event('toggle:right-a')));
    await expect(surface).toHaveCount(0);
    await expect(page.locator('dialog:modal')).toHaveCount(0);
    const toggle = page.getByRole('button', { name: 'Toggle right-a', exact: true });
    await toggle.focus();
    await expect(toggle).toBeFocused();
    await toggle.press('Enter');
    await expect(page.locator('dialog:modal')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(surface).toBeVisible();
    await expect(page.locator('dialog:modal')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
