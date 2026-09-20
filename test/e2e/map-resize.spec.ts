import { test, expect } from '@playwright/test';

for (const density of [1, 2, 3]) {
  test.describe(`${density}× display`, () => {
    test.use({ deviceScaleFactor: density, hasTouch: true, viewport: { width: 390, height: 844 } });

    test('map follows display density through rotation and container resizing', async ({ page }, testInfo) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => {
        localStorage.setItem('zlayers-map-preferences-v1', JSON.stringify({ version: 2, ownshipEnabled: false }));
      });
      await page.goto('/');
      const canvas = page.locator('.maplibregl-canvas');
      await expect(canvas).toBeVisible();
      const checkSize = async () => {
        await expect.poll(() => canvas.evaluate(element => {
          const canvas = element as HTMLCanvasElement;
          const parent = canvas.closest('.map-canvas')!;
          const { width, height } = parent.getBoundingClientRect();
          const ratio = devicePixelRatio;
          return width > 0 && height > 0 && canvas.width === Math.floor(width * ratio)
            && canvas.height === Math.floor(height * ratio);
        })).toBe(true);
      };
      await checkSize();
      for (const viewport of [{ width: 844, height: 390 }, { width: 390, height: 620 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(viewport);
        await checkSize();
      }
      // A container-only resize must still work after removing the app's second
      // ResizeObserver; no window resize event is dispatched for these changes.
      await page.locator('.map-canvas').evaluate(element => { (element as HTMLElement).style.width = '320px'; });
      await checkSize();
      await page.locator('.map-canvas').evaluate(element => { (element as HTMLElement).style.removeProperty('width'); });
      await checkSize();
      await page.getByLabel('Search FAA navigation data').fill('KSBA');
      await page.locator('.search-results button').filter({ hasText: 'KSBA' }).click();
      await expect(page.locator('.feature-card')).toBeVisible();
      await checkSize();
      await page.screenshot({ path: testInfo.outputPath('phone-map.png') });
      expect(errors).toEqual([]);
    });
  });
}
