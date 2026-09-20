import { test, expect, type Page } from '@playwright/test';
import type {} from '../browser/graphics';

const colors = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 128, 0, 128]];
const clear = [0, 0, 0, 0];
function expectColor(actual: number[], expected: number[], label = '') {
  expect(Math.max(...expected.map((value, index) => Math.abs(value - actual[index]!))),
    `${label}: expected ${expected}, got ${actual}`).toBeLessThanOrEqual(2);
}
async function openGraphics(page: Page) {
  await page.goto('/test/browser/graphics.html');
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('body')).toHaveAttribute('data-idle', 'true');
}

test('concurrent pixel-canvas bitmaps retain tile identity across two worker transfers', async ({ page }, testInfo) => {
  await openGraphics(page);
  const result = await page.evaluate(() => window.graphicsFixture.bitmapTransfers());
  await testInfo.attach('bitmap-transfer.json', { body: JSON.stringify(result), contentType: 'application/json' });
  expect(result.count).toBe(256);
  expect(result.failures).toEqual([]);
});

test('chart decoding, overzoom, sparse overview and clipping preserve pixel positions and alpha', async ({ page }) => {
  await openGraphics(page);
  const { native, children, sparse, clipped } = await page.evaluate(() => window.graphicsFixture.chartPixels());
  colors.forEach((color, i) => {
    expectColor(native[i]!, color, `native quadrant ${i}`);
    for (const pixel of children[i]!) expectColor(pixel, color, `overzoom child ${i}`);
    expectColor(sparse[i]!, i === 3 ? clear : color, `sparse overview quadrant ${i}`);
    expectColor(clipped[i]!, color, `clipped quadrant ${i}`);
  });
  expectColor(clipped[4]!, clear, 'missing coverage inside polygon hole');
});

test('all generated navigation icons retain their bounds, centers and transparent margins', async ({ page }) => {
  await openGraphics(page);
  const icons = await page.evaluate(() => window.graphicsFixture.iconPixels());
  expect(icons).toHaveLength(11);
  for (const icon of icons) {
    expect(icon.width).toBe(icon.id === 'vfr-diamond' ? 32 : 64);
    expect(icon.height).toBe(icon.width);
    expect(icon.opaque, icon.id).toBeGreaterThan(100);
    expect(icon.bounds[0], icon.id).toBeGreaterThan(0);
    expect(icon.bounds[1], icon.id).toBeGreaterThan(0);
    expect(icon.bounds[2], icon.id).toBeLessThan(icon.width - 1);
    expect(icon.bounds[3], icon.id).toBeLessThan(icon.height - 1);
    expect(icon.center[3], icon.id).toBe(255);
  }
  expectColor(icons.find(icon => icon.id === 'fix-triangle')!.center, [66, 205, 227, 255]);
  expectColor(icons.find(icon => icon.id === 'navaid-vor')!.center, [241, 245, 246, 255]);
});

test('PNG and composed chart tiles keep their orientation and alpha through MapLibre GPU upload', async ({ page }) => {
  await openGraphics(page);
  for (const composed of [false, true]) {
    const pixels = await page.evaluate(composed => window.graphicsFixture.rasterPixels(composed), composed);
    const expected = [...colors.slice(0, 3), [255, 191, 127, 255]]; // Half-alpha orange over white.
    expected.forEach((color, i) => expectColor(pixels[i]!, color, `${composed ? 'composed' : 'PNG'} quadrant ${i}`));
  }
});

test('map symbols, weather colors and route pixels survive rotation, resize and WebGL restoration', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openGraphics(page);
  const expected: Record<string, number[]> = {
    FIX: [66, 205, 227, 255], VOR: [241, 245, 246, 255], VFR: [255, 189, 102, 255],
    'WX-VFR': [32, 198, 107, 255], 'WX-MVFR': [39, 135, 255, 255],
    'WX-IFR': [240, 68, 68, 255], 'WX-LIFR': [216, 71, 232, 255],
  };
  const check = async () => {
    await expect(page.locator('body')).toHaveAttribute('data-idle', 'true');
    const pixels = await page.evaluate(() => window.graphicsFixture.mapPixels());
    for (const pixel of pixels) {
      if (expected[pixel.name]) expectColor(pixel.color, expected[pixel.name]!, pixel.name);
      if (pixel.name === 'route') {
        expect(pixel.color[2]! - pixel.color[0]!).toBeGreaterThan(100);
        expect(pixel.color[1]! - pixel.color[0]!).toBeGreaterThan(60);
      }
    }
  };
  await check();
  await page.evaluate(() => window.graphicsFixture.camera(37));
  await check();
  await page.setViewportSize({ width: 1133, height: 1000 });
  await check();
  await page.evaluate(() => window.graphicsFixture.restoreContext());
  await expect(page.locator('body')).toHaveAttribute('data-context', 'restored');
  await check();
  await page.screenshot({ path: testInfo.outputPath('graphics-restored.png') });
  expect(await page.evaluate(() => window.graphicsFixture.errors)).toEqual([]);
  expect(errors).toEqual([]);
});

test('saved region boundaries keep the right chart edition and leave unavailable pixels transparent', async ({ page }) => {
  await openGraphics(page);
  const read = (missing: boolean) => page.evaluate(async missing => {
    const path = '/regional-test.js';
    await import(path);
    return (globalThis as unknown as { regionalTestPixels: (missing: boolean) => Promise<unknown> }).regionalTestPixels(missing);
  }, missing);
  expect(await read(false)).toEqual({ truckee: [0, 0, 255, 255], reno: [0, 255, 0, 255] });
  expect(await read(true)).toEqual({ truckee: [0, 0, 255, 255], reno: clear });
});

test('PDF pixels keep their orientation and colors after zooming and tablet rotation', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 744, height: 1133 });
  await page.goto('/');
  await page.getByLabel('Search FAA navigation data').fill('KSBA');
  await page.locator('.search-results button').filter({ hasText: 'KSBA' }).click();
  await page.getByRole('button', { name: 'Plates', exact: true }).click();
  await page.getByRole('button', { name: /TEST APPROACH/ }).click();
  const check = async () => {
    await expect(page.locator('.procedure-page-stage')).toHaveAttribute('aria-busy', 'false');
    const pixels = await page.locator('.procedure-page-stage canvas').evaluate(element => {
      const canvas = element as HTMLCanvasElement, context = canvas.getContext('2d')!;
      return [[0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8], [0.5, 0.5], [0.025, 0.025]].map(([x, y]) =>
        [...context.getImageData(Math.floor(canvas.width * x!), Math.floor(canvas.height * y!), 1, 1).data]);
    });
    const expected = [[255, 0, 0, 255], [0, 255, 0, 255], [255, 255, 0, 255],
      [26, 77, 204, 255], [26, 77, 204, 255], [255, 255, 255, 255]];
    expected.forEach((color, i) => expectColor(pixels[i]!, color, `PDF sample ${i}`));
  };
  await check();
  await page.getByRole('button', { name: 'Enter full screen' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Zoom in', exact: true }).click();
  await check();
  await page.setViewportSize({ width: 1133, height: 744 });
  await check();
  await page.screenshot({ path: testInfo.outputPath('pdf-retina-landscape.png') });
  await page.getByRole('button', { name: 'Close plate', exact: true }).click();
  await page.getByRole('button', { name: /TEST APPROACH/ }).click();
  await check();
});
