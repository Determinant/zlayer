import { test, expect, type Locator, type Page } from '@playwright/test';

test.use({ hasTouch: true });

async function openPlate(page: Page) {
  await page.goto('/');
  await page.getByLabel('Search FAA navigation data').fill('KSBA');
  await page.locator('.search-results button').filter({ hasText: 'KSBA' }).click();
  await page.getByRole('button', { name: 'Plates', exact: true }).click();
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
    return canvas.width > 0 && plate.width > 0 && plate.height > 0 &&
      plate.left >= area.left && plate.top >= area.top &&
      plate.right <= area.right + 1 && plate.bottom <= area.bottom + 1 &&
      stage.scrollWidth <= stage.clientWidth && stage.scrollHeight <= stage.clientHeight;
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
  await expect(page.getByRole('button', { name: 'Plates', exact: true })).toHaveClass('is-active');
});

for (const viewport of [
  { width: 320, height: 568 },
  { width: 393, height: 852 },
  { width: 744, height: 1133 },
]) {
  test(`plate fullscreen fits and rotates with touch controls at ${viewport.width}px`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize(viewport);
    await openPlate(page);
    await expectFittedPage(page);
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
      for (const name of ['Exit full screen', 'Close plate', 'Previous PDF page', 'Next PDF page', 'Zoom out', 'Zoom in']) {
        await expectTouchTarget(page.getByRole('dialog').getByRole('button', { name, exact: true }), page);
      }
      await expect(page.getByRole('link', { name: 'Open original' })).toBeHidden();
      await page.screenshot({ path: testInfo.outputPath(`fullscreen-${orientation}.png`) });
    }

    await page.getByRole('button', { name: 'Exit full screen' }).tap();
    await expect(enter).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('link', { name: 'Open original' })).toBeVisible();
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
