import { test, expect, type Page, type Route } from '@playwright/test';

test.use({ hasTouch: true, isMobile: true, deviceScaleFactor: 2, viewport: { width: 393, height: 852 } });

async function selectPlate(page: Page, beforeOpen?: () => Promise<unknown>) {
  await page.goto('/');
  await page.getByLabel('Search FAA navigation data').fill('KSBA');
  await page.locator('.search-results button').filter({ hasText: 'KSBA' }).click();
  await page.getByRole('button', { name: 'Plates', exact: true }).click();
  const opener = page.getByRole('button', { name: /TEST APPROACH/ });
  // Shared viewer-dialog code must load before intercepting the lazy renderer.
  await beforeOpen?.();
  await opener.click();
  return opener;
}

async function ready(page: Page) {
  await expect(page.locator('.procedure-page-stage')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.procedure-page-stage canvas')).toBeVisible();
  await expect(page.locator('.procedure-page-loading')).toHaveCount(0);
}

test('plate loading keeps the same modal through renderer preparation and PDF downloads', async ({ page }, testInfo) => {
  await page.addInitScript(() => { Reflect.deleteProperty(Navigator.prototype, 'serviceWorker'); });
  let releaseModule!: (route: Route) => void;
  let releasePdf!: (route: Route) => void;
  const moduleRequest = new Promise<Route>(resolve => { releaseModule = resolve; });
  const pdfRequest = new Promise<Route>(resolve => { releasePdf = resolve; });
  await page.route('**/book.pdf*', releasePdf);
  await selectPlate(page, () => page.route('**/assets/viewer-*.js', releaseModule));
  const heldModule = await moduleRequest;
  const dialog = await page.getByRole('dialog').elementHandle();
  const heading = page.getByRole('heading', { name: 'TEST APPROACH', exact: true });
  await expect(heading).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Preparing plate…' })).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Zoom in', exact: true })).toBeDisabled();
  await page.locator('.procedure-viewer').evaluate(element =>
    Promise.all(element.getAnimations().map(animation => animation.finished)));
  const before = await heading.boundingBox();
  await page.screenshot({ path: testInfo.outputPath('plate-preparing-mobile.png') });
  await heldModule.continue();
  const heldPdf = await pdfRequest;
  await expect(page.getByRole('status').filter({ hasText: 'Downloading regional plates…' })).toBeVisible();
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  expect(await dialog!.evaluate(element => element.isConnected)).toBe(true);
  expect(await heading.boundingBox()).toEqual(before);
  await expect(page.locator('.procedure-page-stage canvas')).toBeHidden();
  await heldPdf.continue();
  await ready(page);
  expect(await dialog!.evaluate(element => element.isConnected)).toBe(true);
  expect(await heading.boundingBox()).toEqual(before);
  await page.screenshot({ path: testInfo.outputPath('plate-ready-mobile.png') });
});

test('a plate can close before its renderer loads without reopening or losing focus', async ({ page }) => {
  await page.addInitScript(() => { Reflect.deleteProperty(Navigator.prototype, 'serviceWorker'); });
  let hold!: (route: Route) => void;
  const pending = new Promise<Route>(resolve => { hold = resolve; });
  const opener = await selectPlate(page, () => page.route('**/assets/viewer-*.js', hold));
  const held = await pending;
  await page.getByRole('button', { name: 'Close plate', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(opener).toBeFocused();
  await held.continue();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await opener.click();
  await ready(page);
});

test('external browser magnification sharpens the PDF without resizing its layout or fetching it again', async ({ page, context }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await selectPlate(page);
  await ready(page);
  const canvas = page.locator('.procedure-page-stage canvas');
  const initial = await canvas.evaluate((element: HTMLCanvasElement) => ({ width: element.width, height: element.height,
    cssWidth: element.style.width, cssHeight: element.style.height }));
  const requests: string[] = [];
  page.on('request', request => { if (request.url().includes('.pdf')) requests.push(request.url()); });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
  await expect.poll(() => page.evaluate(() => visualViewport?.scale)).toBe(2);
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.width)).toBeGreaterThan(initial.width * 1.9);
  await ready(page);
  expect(await canvas.evaluate((element: HTMLCanvasElement) => [element.style.width, element.style.height]))
    .toEqual([initial.cssWidth, initial.cssHeight]);
  await expect(page.locator('.procedure-zoom-controls')).toContainText('100%');
  await page.screenshot({ path: testInfo.outputPath('plate-native-pinch.png') });
  await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 5 });
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.width)).toBeGreaterThan(initial.width * 3);
  await ready(page);
  expect(await canvas.evaluate((element: HTMLCanvasElement) => element.width * element.height)).toBeLessThanOrEqual(8_388_608);
  await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
  await expect.poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.width)).toBe(initial.width);
  expect(requests).toEqual([]);
  expect(errors).toEqual([]);
});

test('trackpad pinch updates PDF zoom without also zooming the browser or showing a loading overlay', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', message => { if (message.text().includes('passive')) errors.push(message.text()); });
  page.on('pageerror', error => errors.push(error.message));
  await selectPlate(page);
  await ready(page);
  const stage = page.locator('.procedure-page-stage');
  const initial = await stage.locator('canvas').evaluate((element: HTMLCanvasElement) => element.width);
  const cancelled = await stage.evaluate(element => !element.dispatchEvent(new WheelEvent('wheel', {
    deltaY: -30, ctrlKey: true, bubbles: true, cancelable: true,
  })));
  expect(cancelled).toBe(true);
  await expect(page.locator('.procedure-zoom-controls')).toContainText('135%');
  await expect(page.locator('.procedure-page-loading')).toHaveCount(0);
  await expect.poll(() => stage.locator('canvas').evaluate((element: HTMLCanvasElement) => element.width)).toBeGreaterThan(initial * 1.3);
  await ready(page);
  expect(await page.evaluate(() => visualViewport?.scale)).toBe(1);
  await page.getByRole('dialog').getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(page.locator('.procedure-zoom-controls')).toContainText('162%');
  await ready(page);
  expect(errors).toEqual([]);
});
