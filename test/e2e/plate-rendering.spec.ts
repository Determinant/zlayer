import { test, expect, type Page, type Route } from '@playwright/test';

test.use({ hasTouch: true, isMobile: true, deviceScaleFactor: 2, viewport: { width: 393, height: 852 } });

async function selectPlate(page: Page, beforeOpen?: () => Promise<unknown>) {
  await page.goto('/');
  await page.getByLabel('Search FAA navigation data').fill('KSBA');
  await page.locator('.search-results button').filter({ hasText: 'KSBA' }).click();
  await page.getByRole('tab', { name: 'Plates', exact: true }).click();
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

test('repeated plate open and close releases the display canvas and PDF worker', async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    const state = { live: 0, peak: 0, created: 0 };
    const report = () => { document.body.dataset.pdfWorkers = JSON.stringify(state); };
    window.Worker = class extends NativeWorker {
      pdf: boolean;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.pdf = String(url).includes('pdf.worker');
        if (this.pdf) { state.created++; state.peak = Math.max(state.peak, ++state.live); report(); }
      }
      override terminate() {
        if (this.pdf) { state.live--; this.pdf = false; report(); }
        super.terminate();
      }
    };
  });
  const workers = () => page.locator('body').getAttribute('data-pdf-workers').then(value =>
    JSON.parse(value ?? '{}') as { live: number; peak: number; created: number });
  const opener = await selectPlate(page);
  for (let cycle = 0; cycle < 6; cycle++) {
    await ready(page);
    expect(await workers()).toEqual({ live: 1, peak: 1, created: cycle + 1 });
    const canvas = (await page.locator('.procedure-page-stage canvas').elementHandle())!;
    try {
      expect(await canvas.evaluate((element: HTMLCanvasElement) => element.width * element.height)).toBeGreaterThan(0);
      if (cycle === 0) {
        const dimensions = await canvas.evaluate((element: HTMLCanvasElement) => [element.width, element.height]);
        await page.getByRole('button', { name: 'Hide KSBA plate', exact: true }).click();
        await expect(page.locator('.procedure-page-stage canvas')).toBeHidden();
        expect(await canvas.evaluate((element: HTMLCanvasElement) => [element.width, element.height])).toEqual(dimensions);
        expect((await workers()).live).toBe(1);
        await page.getByRole('button', { name: 'Show KSBA plate', exact: true }).click();
        await ready(page);
      }
      await page.getByRole('button', { name: 'Close plate', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.locator('.procedure-page-stage canvas')).toHaveCount(0);
      // Retain the detached DOM node to prove explicit backing-store release,
      // independently of browser GC timing or total process-memory reporting.
      expect(await canvas.evaluate((element: HTMLCanvasElement) => [element.width, element.height])).toEqual([0, 0]);
      await expect.poll(async () => (await workers()).live).toBe(0);
    } finally { await canvas.dispose(); }
    if (cycle < 5) {
      await page.getByRole('button', { name: 'Show KSBA details', exact: true }).click();
      await opener.click();
    }
  }
});

test('plate loading keeps the same panel through renderer preparation and PDF downloads', async ({ page }, testInfo) => {
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
  await expect(page.getByRole('button', { name: 'Rotate 90° clockwise' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Reset plate view' })).toBeDisabled();
  await page.locator('.side-panels').evaluate(element =>
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
  const airportTab = page.getByRole('button', { name: 'Show KSBA details', exact: true });
  await expect(airportTab).toBeFocused();
  await airportTab.press('Enter');
  await held.continue();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await opener.click();
  await ready(page);
});

test('external browser magnification sharpens the PDF without resizing its layout or fetching it again', async ({ page, context, browserName }, testInfo) => {
  test.skip(browserName !== 'chromium', 'Native page magnification requires CDP; PDF gesture handling is covered across engines.');
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

test('height-only reader resizing preserves the rendered PDF bitmap', async ({ page }) => {
  await selectPlate(page); await ready(page);
  const stage = page.locator('.procedure-page-stage');
  await stage.evaluate(element => {
    const canvas = element.querySelector('canvas')!;
    const context = canvas.getContext('2d')!;
    const tracked = canvas as HTMLCanvasElement & { reviewDraws: number };
    tracked.reviewDraws = 0;
    context.drawImage = new Proxy(context.drawImage, { apply(draw, receiver, args) {
      tracked.reviewDraws++; return Reflect.apply(draw, receiver, args);
    } });
  });
  const before = await stage.locator('canvas').evaluate((canvas: HTMLCanvasElement) => [canvas.width, canvas.height]);
  const area = await stage.evaluate(element => ({ width: element.clientWidth, height: element.clientHeight }));
  await stage.evaluate(async element => {
    const height = element.clientHeight;
    (element as HTMLElement).style.flex = 'none';
    (element as HTMLElement).style.height = `${height - 40}px`;
    await new Promise<void>(resolve => new ResizeObserver((_entries, observer) => { observer.disconnect(); resolve(); }).observe(element));
    for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame);
  });
  await ready(page);
  const resized = await stage.evaluate(element => ({ width: element.clientWidth, height: element.clientHeight }));
  expect(resized.width).toBe(area.width);
  expect(resized.height).toBeGreaterThan(0);
  expect(resized.height).toBeLessThan(area.height);
  expect(await stage.locator('canvas').evaluate((canvas: HTMLCanvasElement & { reviewDraws: number }) =>
    ({ dimensions: [canvas.width, canvas.height], draws: canvas.reviewDraws }))).toEqual({ dimensions: before, draws: 0 });
  // A zoom change must still reach the instrumented canvas.
  await page.getByRole('dialog').getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect.poll(() => stage.locator('canvas').evaluate((canvas: HTMLCanvasElement & { reviewDraws: number }) =>
    canvas.reviewDraws)).toBeGreaterThan(0);
  await ready(page);
});
