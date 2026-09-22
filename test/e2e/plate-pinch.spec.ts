import { test, expect, type Page } from '@playwright/test';

test.use({ hasTouch: true, deviceScaleFactor: 2, viewport: { width: 744, height: 1133 } });

async function openPlate(page: Page) {
  await page.goto('/');
  await page.getByLabel('Search FAA navigation data').fill('KSBA');
  await page.locator('.search-results button').filter({ hasText: 'KSBA' }).click();
  await page.getByRole('tab', { name: 'Plates', exact: true }).click();
  // An unreachable origin can require two bounded catalog fallbacks in WebKit.
  await page.getByRole('button', { name: /TEST APPROACH/ }).click({ timeout: 30_000 });
  await ready(page);
  await settledPanel(page);
}

async function ready(page: Page) {
  await expect(page.locator('.procedure-page-stage')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.procedure-page-stage canvas')).toBeVisible();
}

async function settledPanel(page: Page) {
  // The ancestor drives the slide; the viewer itself has no position animation.
  await expect.poll(() => page.locator('.procedure-panel').evaluate(panel => {
    const group = panel.closest('.edge-panels');
    return !!group && Number(getComputedStyle(group).getPropertyValue('--edge-panel-reveal')) === 1 &&
      group.getAnimations().every(animation => animation.playState !== 'running');
  })).toBe(true);
}

type Point = { id: number; x: number; y: number };
async function touch(page: Page, type: string, points: Point[]) {
  return page.locator('.procedure-page-stage').evaluate((stage, { type, points }) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'touches', { value: points.map(point => ({
      identifier: point.id, clientX: point.x, clientY: point.y, target: stage.querySelector('canvas'),
    })) });
    stage.dispatchEvent(event);
    return event.defaultPrevented;
  }, { type, points });
}

async function gesture(page: Page, type: string, scale: number) {
  return page.locator('.procedure-page-stage').evaluate((stage, { type, scale }) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'scale', { value: scale });
    stage.dispatchEvent(event);
    return event.defaultPrevented;
  }, { type, scale });
}

test('touch pinch changes PDF zoom around the fingers and redraws sharply after release', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openPlate(page);
  const canvas = page.locator('.procedure-page-stage canvas');
  const rect = (await canvas.boundingBox())!;
  const initial = await canvas.evaluate((element: HTMLCanvasElement) => element.width);
  const x = rect.x + rect.width * 0.45, y = rect.y + rect.height * 0.45;
  const points = (distance: number) => [{ id: 1, x: x - distance / 2, y }, { id: 2, x: x + distance / 2, y }];
  const pdfRequests: string[] = [];
  page.on('request', request => { if (request.url().includes('.pdf')) pdfRequests.push(request.url()); });
  expect(await touch(page, 'touchstart', points(100))).toBe(true);
  expect(await touch(page, 'touchmove', points(200))).toBe(true);
  await expect(page.locator('.procedure-zoom-controls')).toContainText('200%');
  expect(await canvas.evaluate((element: HTMLCanvasElement) => element.width)).toBe(initial);
  const preview = (await canvas.boundingBox())!;
  expect(preview.width).toBeCloseTo(rect.width * 2, 0);
  expect(preview.x + preview.width * 0.45).toBeCloseTo(x, 0);
  expect(preview.y + preview.height * 0.45).toBeCloseTo(y, 0);
  // Safari sends both touch and gesture events for the same fingers.
  expect(await gesture(page, 'gesturechange', 2)).toBe(true);
  await expect(page.locator('.procedure-zoom-controls')).toContainText('200%');
  expect(await touch(page, 'touchend', [])).toBe(true);
  await ready(page);
  expect(await canvas.evaluate((element: HTMLCanvasElement) => element.width)).toBeGreaterThan(initial * 1.9);
  expect(await page.evaluate(() => visualViewport?.scale)).toBe(1);
  expect(await page.locator('.procedure-page-stage').evaluate(element => getComputedStyle(element).touchAction)).toBe('pan-x pan-y');
  expect(pdfRequests).toEqual([]);
  await page.getByRole('dialog').getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(page.locator('.procedure-zoom-controls')).toContainText('240%');
  await ready(page);
  expect(errors).toEqual([]);
});

test('pinch bounds, remaining-finger pan, cancellation and reopening keep a usable viewer', async ({ page }) => {
  await openPlate(page);
  const stage = page.locator('.procedure-page-stage');
  const rect = (await stage.boundingBox())!;
  const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
  const points = (distance: number) => [{ id: 1, x: x - distance / 2, y }, { id: 2, x: x + distance / 2, y }];
  expect(await touch(page, 'touchstart', [points(100)[0]!]), 'one finger keeps native scrolling').toBe(false);
  await touch(page, 'touchstart', points(100));
  await touch(page, 'touchmove', points(500));
  await expect(page.locator('.procedure-zoom-controls')).toContainText('400%');
  const finger = points(200)[0]!;
  await touch(page, 'touchend', [finger]);
  await ready(page);
  const before = await stage.evaluate(element => element.scrollTop);
  await touch(page, 'touchmove', [{ ...finger, y: finger.y - 40 }]);
  expect(await stage.evaluate(element => element.scrollTop)).toBeGreaterThan(before + 35);
  await touch(page, 'touchend', []);
  await touch(page, 'touchstart', points(200));
  await touch(page, 'touchmove', points(10));
  await expect(page.locator('.procedure-zoom-controls')).toContainText('50%');
  await touch(page, 'touchcancel', []);
  await ready(page);
  await page.getByRole('button', { name: 'Close plate' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show KSBA details', exact: true }).click();
  await page.getByRole('button', { name: /TEST APPROACH/ }).click();
  await ready(page);
  // Closing and reopening retains the plate's saved reading state.
  await expect(page.locator('.procedure-zoom-controls')).toContainText('50%');
});

test('Safari gesture events without touch events also update PDF zoom', async ({ page }) => {
  await openPlate(page);
  expect(await gesture(page, 'gesturestart', 1)).toBe(true);
  expect(await gesture(page, 'gesturechange', 1.5)).toBe(true);
  await expect(page.locator('.procedure-zoom-controls')).toContainText('150%');
  expect(await gesture(page, 'gestureend', 1.5)).toBe(true);
  await ready(page);
  expect(await page.evaluate(() => visualViewport?.scale)).toBe(1);
});

test('a saved plate supports pinch zoom after a fresh offline app start', async ({ page, context, request }) => {
  await openPlate(page);
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  // WebKit's offline emulation rejects even responses generated by a service
  // worker. Disconnect the actual origin so cached navigation can still run.
  await request.post('/__test/disconnect');
  try {
    await expect(request.get('/')).rejects.toThrow();
    const offline = await context.newPage();
    await offline.addInitScript(() => Object.defineProperty(navigator, 'onLine', { get: () => false }));
    await page.close();
    // Cold startup restores the selected plate without another airport search.
    await offline.goto('/');
    await ready(offline);
    await settledPanel(offline);
    const rect = (await offline.locator('.procedure-page-stage canvas').boundingBox())!;
    const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    await touch(offline, 'touchstart', [{ id: 1, x: x - 50, y }, { id: 2, x: x + 50, y }]);
    await touch(offline, 'touchmove', [{ id: 1, x: x - 75, y }, { id: 2, x: x + 75, y }]);
    await touch(offline, 'touchend', []);
    await expect(offline.locator('.procedure-zoom-controls')).toContainText('150%');
    await ready(offline);
    expect(await offline.evaluate(() => visualViewport?.scale)).toBe(1);
  } finally { await request.post('/__test/reset'); }
});

test('browser-delivered two-finger input zooms the PDF without magnifying the window', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'Native multitouch injection requires CDP; shared event handling is checked on every engine.');
  await openPlate(page);
  const rect = (await page.locator('.procedure-page-stage canvas').boundingBox())!;
  const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
  const cdp = await context.newCDPSession(page);
  const points = (distance: number) => [{ id: 1, x: x - distance / 2, y }, { id: 2, x: x + distance / 2, y }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(100) });
  for (const distance of [120, 140, 160, 180, 200]) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(distance) });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(page.locator('.procedure-zoom-controls')).toContainText('200%');
  await ready(page);
  expect(await page.evaluate(() => visualViewport?.scale)).toBe(1);
});
