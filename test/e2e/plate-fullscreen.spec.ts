import { test, expect, type Locator, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { degrees, PDFDocument, rgb } from 'pdf-lib';

test.use({ hasTouch: true });

async function openPlate(page: Page) {
  await page.goto('/');
  await page.getByLabel('Search FAA navigation data').fill('KSBA');
  await page.locator('.search-results button').filter({ hasText: 'KSBA' }).click();
  await page.getByRole('tab', { name: 'Plates', exact: true }).click();
  const opener = page.getByRole('button', { name: /TEST APPROACH/ });
  await opener.click();
  await expect(page.getByText('Available offline', { exact: true })).toBeVisible();
  await expect(page.locator('.procedure-page-loading')).toHaveCount(0);
  await page.locator('.side-panels').evaluate(element =>
    Promise.all(element.getAnimations().map(animation => animation.finished)));
  return opener;
}

async function expectFittedPage(page: Page) {
  await expect.poll(() => page.locator('.procedure-page-stage').evaluate(stage => {
    const canvas = stage.querySelector('canvas')!;
    const area = stage.getBoundingClientRect();
    const plate = canvas.getBoundingClientRect();
    const style = getComputedStyle(stage);
    const availableWidth = stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    return canvas.width > 0 && plate.width > 0 && plate.height > 0 &&
      Math.abs(plate.width - availableWidth) <= 1 &&
      Math.abs(plate.top - area.top - parseFloat(style.paddingTop)) <= 1 &&
      plate.left >= area.left && plate.right <= area.right + 1 &&
      stage.scrollWidth <= stage.clientWidth && stage.scrollTop === 0;
  })).toBe(true);
}

async function expectTouchTarget(control: Locator, page: Page) {
  await expect(control).toBeVisible();
  const box = (await control.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(Math.round(box.width)).toBeGreaterThanOrEqual(44);
  expect(Math.round(box.height)).toBeGreaterThanOrEqual(44);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
}

async function expectSingleControlRow(page: Page) {
  const row = page.locator('.procedure-reading-controls');
  await expect.poll(() => row.evaluate(element => {
    const area = element.getBoundingClientRect();
    const controls = [...element.querySelectorAll('button')]
      .map(button => button.getBoundingClientRect()).filter(box => box.width > 0 && box.height > 0);
    return controls.length >= 4 && controls.every(box =>
      Math.abs(box.top - controls[0]!.top) <= 1 && box.left >= area.left - 1 && box.right <= area.right + 1) &&
      element.scrollWidth <= element.clientWidth;
  })).toBe(true);
}

test('an open plate and airport keep their state through fold and tablet size changes', async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 915 });
  await openPlate(page);
  const edition = await page.locator('.feature-edition').textContent();
  const requests: string[] = [];
  page.on('request', request => { if (request.url().includes('.pdf')) requests.push(request.url()); });
  for (const [width, height] of [[832, 906], [906, 832], [744, 1133], [1133, 744], [820, 1180], [1180, 820], [412, 915]]) {
    await page.setViewportSize({ width: width!, height: height! });
    await expectFittedPage(page);
    await expect(page.locator('.procedure-page-controls')).toContainText('Page 1 / 1');
    await expectTouchTarget(page.getByRole('button', { name: 'Close plate', exact: true }), page);
  }
  expect(requests).toEqual([]);
  await page.getByRole('button', { name: 'Close plate', exact: true }).click();
  await page.getByRole('button', { name: 'Show KSBA details', exact: true }).click();
  await expect(page.locator('.feature-edition')).toHaveText(edition!);
  await expect(page.getByRole('tab', { name: 'Plates', exact: true })).toHaveAttribute('aria-selected', 'true');
});

for (const viewport of [
  { width: 320, height: 568 },
  { width: 375, height: 667 },
  { width: 393, height: 852 },
  { width: 560, height: 900 },
  { width: 744, height: 1133 },
]) {
  test(`plate fullscreen fits and rotates with touch controls at ${viewport.width}px`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize(viewport);
    await openPlate(page);
    await expectFittedPage(page);
    await expectSingleControlRow(page);
    await expectTouchTarget(page.getByRole('button', { name: 'Reset plate view' }), page);
    const normalStage = (await page.locator('.procedure-page-stage').boundingBox())!;
    const enter = page.getByRole('button', { name: 'Enter full screen' });
    await expectTouchTarget(enter, page);
    await page.screenshot({ path: testInfo.outputPath('normal.png') });
    await enter.tap();
    await expect(page.getByRole('button', { name: 'Exit full screen' })).toHaveAttribute('aria-pressed', 'true');
    const expandedStage = (await page.locator('.procedure-page-stage').boundingBox())!;
    expect(expandedStage.height).toBeGreaterThan(normalStage.height);
    if (viewport.width > 720) expect(expandedStage.width).toBeGreaterThan(normalStage.width);

    for (const [orientation, size] of [
      ['portrait', viewport],
      ['landscape', { width: viewport.height, height: viewport.width }],
    ] as const) {
      await page.setViewportSize(size);
      await expectFittedPage(page);
      const viewer = (await page.locator('.procedure-viewer').boundingBox())!;
      expect(viewer).toEqual({ x: 0, y: 0, ...size });
      await expectSingleControlRow(page);
      for (const name of ['Exit full screen', 'Close plate', 'Zoom out', 'Zoom in', 'Reset plate view', 'Rotate 90° clockwise']) {
        await expectTouchTarget(page.getByRole('dialog').getByRole('button', { name, exact: true }), page);
      }
      const picker = page.getByRole('button', { name: /Choose PDF page/ });
      if (await picker.isVisible()) await picker.click();
      for (const name of ['Previous PDF page', 'Next PDF page']) {
        await expectTouchTarget(page.getByRole('button', { name, exact: true }), page);
      }
      if (await picker.isVisible()) {
        await page.keyboard.press('Escape');
        await expect(picker).toHaveAttribute('aria-expanded', 'false');
        await expect(picker).toBeFocused();
      }
      await page.getByRole('button', { name: 'Rotate 90° clockwise' }).tap();
      await expect(page.locator('.procedure-page-stage')).toHaveAttribute('aria-busy', 'false');
      await expectFittedPage(page);
      await expect(page.getByRole('link', { name: 'Open original' })).toBeHidden();
      await page.screenshot({ path: testInfo.outputPath(`fullscreen-${orientation}.png`) });
    }

    await page.getByRole('button', { name: 'Exit full screen' }).tap();
    await expect(enter).toHaveAttribute('aria-pressed', 'false');
    const picker = page.getByRole('button', { name: /Choose PDF page/ });
    if (await picker.isVisible()) await picker.click();
    await expect(page.getByRole('link', { name: 'Open original' })).toBeVisible();
    if (await picker.isVisible()) {
      const stage = page.locator('.procedure-page-stage');
      const area = (await stage.boundingBox())!;
      await stage.click({ position: { x: area.width - 8, y: 8 } });
      await expect(picker).toHaveAttribute('aria-expanded', 'false');
    }
    await expectFittedPage(page);
    await page.getByRole('button', { name: 'Close plate' }).tap();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test('fullscreen keeps the loaded plate and zoom, excludes background focus, and restores the keyboard opener on close', async ({ page }) => {
  const opener = await openPlate(page);
  const dialog = page.getByRole('dialog');
  // Exercise focus restoration on reopening an already cached plate.
  await page.getByRole('button', { name: 'Close plate' }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Show KSBA details', exact: true }).click();
  // macOS WebKit does not focus buttons on pointer clicks. Restore focus to a
  // keyboard opener, which is the native dialog contract on every platform.
  await opener.focus();
  await expect(opener).toBeFocused();
  await opener.press('Enter');
  await expect(page.locator('.procedure-page-loading')).toHaveCount(0);
  const enter = page.getByRole('button', { name: 'Enter full screen' });
  await dialog.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(page.locator('.procedure-zoom-controls')).toContainText('120%');
  const pdfRequests: string[] = [];
  page.on('request', request => { if (request.url().includes('.pdf')) pdfRequests.push(request.url()); });
  await enter.click();
  await expect(page.locator('.procedure-zoom-controls')).toContainText('120%');
  await expect(page.locator('.procedure-page-controls')).toContainText('Page 1 / 1');
  const search = page.getByLabel('Search FAA navigation data');
  await search.evaluate(element => element.focus());
  await expect(search).not.toBeFocused();
  for (let index = 0; index < 8; index++) {
    await page.keyboard.press('Tab');
    // Native dialogs allow keyboard access to browser chrome (activeElement is body).
    expect(await dialog.evaluate(element => document.activeElement === document.body ||
      element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(enter).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(page.locator('.procedure-zoom-controls')).toContainText('120%');
  await enter.click();
  await page.getByRole('button', { name: 'Exit full screen' }).click();
  await expect(page.locator('.procedure-zoom-controls')).toContainText('120%');
  expect(pdfRequests).toEqual([]);
  await enter.click();
  await page.getByRole('button', { name: 'Close plate' }).click();
  await expect(dialog).toHaveCount(0);
  const airportTab = page.getByRole('button', { name: 'Show KSBA details', exact: true });
  await expect(airportTab).toBeFocused();
  await airportTab.press('Enter');
  await opener.focus();
  await expect(opener).toBeFocused();
  await opener.press('Enter');
  await expect(page.getByRole('button', { name: 'Exit full screen' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.procedure-zoom-controls')).toContainText('120%');
  await page.keyboard.press('Escape');
  await expect(enter).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  const show = page.getByRole('button', { name: 'Show KSBA plate', exact: true });
  await expect(show).toBeFocused();
  await show.press('Enter');
  await expect(dialog).toBeVisible();
  await expect(page.locator('.procedure-zoom-controls')).toContainText('120%');
  await page.getByRole('button', { name: 'Close plate', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Show KSBA details', exact: true })).toBeFocused();
});

test('reset restores fit width, orientation and scroll while keeping the current page and fullscreen', async ({ page }) => {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 400]);
  pdf.addPage([200, 400]).drawRectangle({ x: 20, y: 340, width: 40, height: 40, color: rgb(1, 0, 0) });
  const body = Buffer.from(await pdf.save());
  await page.addInitScript(() => { Reflect.deleteProperty(Navigator.prototype, 'serviceWorker'); });
  await page.route('**/reset-test.pdf', route => route.fulfill({ contentType: 'application/pdf', body }));
  await page.addInitScript(() => localStorage.setItem('zlayer-plugin:plates:plate-selection', JSON.stringify({ version: 1, value: {
    airport: { id: 'KSBA' }, procedure: { id: 'reset-test', name: 'Reset test' },
    cycle: '2026-09-03', effectiveDate: '2026-09-03', expirationDate: '2026-10-01',
    document: { url: `${location.origin}/reset-test.pdf`, nativeUrl: `${location.origin}/reset-test.pdf`,
      pageIndex: 0, source: 'faa-individual' },
  } })));
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto('/');
  const stage = page.locator('.procedure-page-stage');
  await expect(stage).toHaveAttribute('aria-busy', 'false');
  await expect(stage.locator('canvas')).toBeVisible();
  await page.getByRole('button', { name: /Choose PDF page/ }).click();
  await page.getByRole('button', { name: 'Next PDF page' }).click();
  await expect(page.getByRole('button', { name: /Choose PDF page/ })).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: 'Enter full screen' }).click();
  await page.getByRole('button', { name: 'Rotate 90° clockwise' }).click();
  for (let index = 0; index < 8; index++) await page.getByRole('dialog').getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(stage).toHaveAttribute('aria-busy', 'false');
  await stage.evaluate(element => element.scrollTo(50, 80));
  await expect.poll(() => stage.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Reset plate view' }).click();
  await expect(stage).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('button', { name: 'Reset plate view' })).toContainText('100%');
  await expect(page.locator('.procedure-page-controls')).toContainText('Page 2 / 2');
  await expect(page.getByRole('button', { name: 'Exit full screen' })).toBeVisible();
  await expectFittedPage(page);
  await expect.poll(() => stage.locator('canvas').evaluate(canvas => {
    const rect = canvas.getBoundingClientRect();
    return rect.width / rect.height;
  })).toBeCloseTo(1 / 2, 2);
  // A scroll-only reset must also resume recording subsequent reading positions.
  await stage.evaluate(element => element.scrollTo({ top: 60 }));
  await page.getByRole('button', { name: 'Reset plate view' }).click();
  await expect.poll(() => stage.evaluate(element => element.scrollTop)).toBe(0);
  await stage.evaluate(element => element.scrollTo({ top: 50 }));
  await expect.poll(() => stage.evaluate(element => element.scrollTop)).toBe(50);
  await page.reload();
  await expect(stage).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByRole('button', { name: 'Reset plate view' })).toContainText('100%');
  await expect(page.locator('.procedure-page-controls')).toContainText('Page 2 / 2');
  await expect.poll(() => stage.evaluate(element => element.scrollTop)).toBe(50);
});

test('plate rotation turns clockwise, wraps after four turns and restores with zoom after reload', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openPlate(page);
  const stage = page.locator('.procedure-page-stage');
  const rotate = page.getByRole('button', { name: 'Rotate 90° clockwise' });
  const expectRedCorner = async (x: number, y: number) => {
    await expect(stage).toHaveAttribute('aria-busy', 'false');
    await expect.poll(() => stage.locator('canvas').evaluate((canvas: HTMLCanvasElement, point) =>
      Array.from(canvas.getContext('2d')!.getImageData(
        Math.floor(canvas.width * point.x), Math.floor(canvas.height * point.y), 1, 1).data), { x, y }))
      .toEqual([255, 0, 0, 255]);
  };
  await expectRedCorner(0.2, 0.2);
  const requests: string[] = [];
  page.on('request', request => { if (request.url().includes('.pdf')) requests.push(request.url()); });
  for (const [x, y] of [[0.8, 0.2], [0.8, 0.8], [0.2, 0.8], [0.2, 0.2]] as const) {
    await rotate.click();
    await expectRedCorner(x, y);
    await expectFittedPage(page);
  }
  await page.getByRole('dialog').getByRole('button', { name: 'Zoom in', exact: true }).click();
  await rotate.click();
  await expectRedCorner(0.8, 0.2);
  await expect(page.locator('.procedure-zoom-controls')).toContainText('120%');
  await page.getByRole('button', { name: 'Enter full screen' }).click();
  await expectRedCorner(0.8, 0.2);
  expect(requests).toEqual([]);
  await page.reload();
  await expectRedCorner(0.8, 0.2);
  await expect(page.getByRole('button', { name: 'Exit full screen' })).toBeVisible();
  await expect(page.locator('.procedure-zoom-controls')).toContainText('120%');
  expect(errors).toEqual([]);
});

test('rotating a rectangular PDF preserves its original orientation and refits each quarter turn', async ({ page }) => {
  const pdf = await PDFDocument.create();
  const sheet = pdf.addPage([200, 300]);
  sheet.setRotation(degrees(90));
  sheet.drawRectangle({ x: 20, y: 240, width: 40, height: 40, color: rgb(1, 0, 0) });
  const body = Buffer.from(await pdf.save());
  await page.addInitScript(() => { Reflect.deleteProperty(Navigator.prototype, 'serviceWorker'); });
  await page.route('**/rotation-test.pdf*', route => route.fulfill({ body, contentType: 'application/pdf' }));
  await page.route('**/tpp/catalog.json*', async route => {
    const response = await route.fetch();
    const catalog = await response.json();
    Object.assign(catalog.volumes[0], { url: '../rotation-test.pdf', byteLength: body.length,
      sha256: createHash('sha256').update(body).digest('hex') });
    await route.fulfill({ response, json: catalog });
  });
  await page.setViewportSize({ width: 393, height: 852 });
  await openPlate(page);
  const stage = page.locator('.procedure-page-stage');
  const expectAspect = async (ratio: number) => {
    await expect(stage).toHaveAttribute('aria-busy', 'false');
    await expect.poll(() => stage.locator('canvas').evaluate(canvas => {
      const rect = canvas.getBoundingClientRect();
      return rect.width / rect.height;
    })).toBeCloseTo(ratio, 2);
    await expectFittedPage(page);
  };
  await expectAspect(1.5);
  for (const ratio of [2 / 3, 1.5, 2 / 3, 1.5]) {
    await page.getByRole('button', { name: 'Rotate 90° clockwise' }).click();
    await expectAspect(ratio);
    if (ratio < 1) {
      await expect.poll(() => stage.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
      await stage.evaluate(element => element.scrollTo({ top: 100 }));
      await expect.poll(() => stage.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    }
  }
});
