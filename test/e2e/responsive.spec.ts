import { test, expect, type Locator, type Page } from '@playwright/test';

test.use({ hasTouch: true });
test.beforeEach(async ({ request }) => { await request.post('/__test/reset'); });

async function openAirport(page: Page) {
  await page.getByLabel('Search FAA navigation data').fill('KSBA');
  await page.locator('.search-results button').filter({ hasText: 'KSBA' }).click();
  await expect(page.locator('.feature-card')).toBeVisible();
}

async function touchTarget(control: Locator) {
  const box = (await control.boundingBox())!;
  // Translated panels can report 43.9999847 for a 44px control. Allow only
  // floating-point error, well below a CSS layout subpixel.
  expect(box.width).toBeGreaterThanOrEqual(44 - 0.001);
  expect(box.height).toBeGreaterThanOrEqual(44 - 0.001);
}

async function inside(control: Locator, bounds: { left: number; top: number; right: number; bottom: number }) {
  await expect.poll(async () => {
    const box = await control.boundingBox();
    return !!box && box.width > 0 && box.height > 0 && box.x >= bounds.left - 1 && box.y >= bounds.top - 1 &&
      box.x + box.width <= bounds.right + 1 && box.y + box.height <= bounds.bottom + 1;
  }).toBe(true);
}

for (const [width, height] of [
  [320, 568], [393, 852], [852, 393], [568, 320], [393, 400], [561, 700], [640, 700], [641, 700],
  [412, 915], [832, 906], [906, 832], [744, 1133], [1133, 744],
  [820, 1180], [1180, 820], [1024, 1366], [1440, 900],
] as const) {
  test(`search, cards and layer controls remain usable at ${width}×${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    const input = page.getByLabel('Search FAA navigation data');
    await expect(input).toBeVisible();
    // Reserve actual text space, after input padding, for an airport or fix.
    expect(await input.evaluate(element => {
      const css = getComputedStyle(element);
      return element.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
    })).toBeGreaterThanOrEqual(140);
    const settings = page.getByLabel('Settings and offline downloads');
    await touchTarget(settings);
    const searchBox = (await input.boundingBox())!;
    const settingsBox = (await settings.boundingBox())!;
    expect(settingsBox.y).toBe(searchBox.y);
    expect(settingsBox.x).toBeGreaterThanOrEqual(searchBox.x + searchBox.width);
    await expect(page.getByRole('button', { name: 'About ZLayer', exact: true })).toBeHidden();
    await expect(page.getByLabel('FAA data cycle')).toBeHidden();
    await settings.click();
    const cycle = page.getByLabel('FAA data cycle');
    await expect(cycle.locator('option:checked')).toHaveText('Default · Latest');
    await touchTarget(cycle);
    await inside(cycle, { left: 0, top: 0, right: width, bottom: height });
    await expect(page.getByRole('button', { name: 'About ZLayer', exact: true })).toBeVisible();
    await page.getByLabel('Close settings').click();
    await expect(page.locator('.maplibregl-ctrl-zoom-in')).toBeVisible();
    const attribution = page.locator('.maplibregl-ctrl-attrib-inner');
    const attributionToggle = page.getByLabel('Toggle attribution');
    await expect(attribution).toBeHidden();
    await touchTarget(attributionToggle);
    await attributionToggle.click();
    await expect(attribution).toBeVisible();
    await expect(attribution).toContainText('FAA aeronautical data');
    await attributionToggle.press('Enter');
    await expect(attribution).toBeHidden();
    await touchTarget(page.locator('.maplibregl-ctrl-zoom-in'));
    await page.locator('.maplibregl-ctrl-zoom-in').click({ trial: true });
    await openAirport(page);
    await touchTarget(page.getByLabel('Add KSBA to end of route'));
    await touchTarget(page.getByLabel('Close detail'));
    const body = page.locator('.feature-card-content');
    expect((await body.boundingBox())!.height).toBeGreaterThanOrEqual(60);
    await page.getByRole('tab', { name: 'Plates', exact: true }).click();
    const plate = page.getByRole('button', { name: /TEST APPROACH/ });
    await plate.scrollIntoViewIfNeeded();
    const area = (await body.boundingBox())!;
    await inside(plate, { left: area.x, top: area.y, right: area.x + area.width, bottom: area.y + area.height });
    await page.getByLabel('Close detail').click();
    await page.getByRole('button', { name: 'Open map layers', exact: true }).click();
    await page.locator('.layer-popover').evaluate(element =>
      Promise.all(element.getAnimations().map(animation => animation.finished)));
    const layers = page.locator('.layer-popover-content');
    expect((await layers.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const initialArea = (await layers.boundingBox())!;
    await inside(layers.locator('.segmented-list button').first(), { left: initialArea.x, top: initialArea.y,
      right: initialArea.x + initialArea.width, bottom: initialArea.y + initialArea.height });
    const lastLayer = layers.getByRole('switch').last();
    await lastLayer.scrollIntoViewIfNeeded();
    const layerArea = (await layers.boundingBox())!;
    await inside(lastLayer, { left: layerArea.x, top: layerArea.y,
      right: layerArea.x + layerArea.width, bottom: layerArea.y + layerArea.height });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('recommendations and settings respect safe areas in portrait and landscape', async ({ page }) => {
  const session = await page.context().newCDPSession(page);
  await page.setViewportSize({ width: 393, height: 852 });
  await session.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 59, bottom: 34, left: 0, right: 0 } });
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Add route waypoint', exact: true }).fill('KSBA KSMO');
  await page.getByRole('button', { name: 'Advise', exact: true }).click();
  await inside(page.locator('.route-recommendations'), { left: 0, top: 59, right: 393, bottom: 818 });
  await touchTarget(page.getByLabel('Close recommendations'));
  const use = page.getByRole('button', { name: /^Use / }).first();
  await expect(use).toBeVisible();
  await touchTarget(use);
  await use.scrollIntoViewIfNeeded();
  await inside(use, { left: 0, top: 59, right: 393, bottom: 818 });
  await page.getByLabel('Close recommendations').click();
  await page.setViewportSize({ width: 568, height: 320 });
  await session.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, bottom: 21, left: 44, right: 44 } });
  await page.getByRole('button', { name: 'Settings and offline downloads', exact: true }).click();
  await inside(page.locator('.settings-dialog'), { left: 44, top: 0, right: 524, bottom: 299 });
  await touchTarget(page.getByRole('button', { name: 'Close settings', exact: true }));
  await page.getByRole('button', { name: 'About ZLayer', exact: true }).click();
  await inside(page.getByRole('dialog', { name: 'About ZLayer' }), { left: 44, top: 0, right: 524, bottom: 299 });
  await expect(page.getByLabel('Close about dialog')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'About ZLayer' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'About ZLayer', exact: true })).toBeFocused();
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 744, height: 1133 });
  await session.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, bottom: 0, left: 0, right: 0 } });
  expect(await page.locator('.region-filters input').evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
  await session.detach();
});

test('visual viewport resizing keeps search and settings above the keyboard without chasing pinch zoom', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  // Desktop emulation has no OS keyboard. Change only the visual viewport, leaving
  // layout dimensions and media queries untouched, as mobile keyboards can do.
  await page.addInitScript(() => {
    const viewport = Object.assign(new EventTarget(), {
      width: innerWidth, height: innerHeight, offsetTop: 0, offsetLeft: 0, scale: 1,
    });
    Object.defineProperty(window, 'visualViewport', { value: viewport });
  });
  await page.goto('/');
  await page.getByLabel('Search FAA navigation data').fill('KS');
  await expect(page.locator('.search-results button').first()).toBeVisible();
  await page.evaluate(() => {
    Object.assign(visualViewport!, { height: 180, offsetTop: 30 });
    visualViewport!.dispatchEvent(new Event('resize'));
    visualViewport!.dispatchEvent(new Event('scroll'));
  });
  await inside(page.locator('.search-results'), { left: 0, top: 30, right: 393, bottom: 210 });
  const last = page.locator('.search-results button').last();
  await last.scrollIntoViewIfNeeded();
  await inside(last, { left: 0, top: 30, right: 393, bottom: 210 });
  await page.getByLabel('Clear search').click();
  await page.getByRole('button', { name: 'Settings and offline downloads', exact: true }).click();
  await inside(page.locator('.settings-dialog'), { left: 0, top: 30, right: 393, bottom: 210 });
  await page.getByLabel('Close settings').click();
  await page.evaluate(() => {
    Object.assign(visualViewport!, { height: innerHeight, offsetTop: 0 });
    visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect.poll(async () => (await page.locator('.app-shell').boundingBox())!.height).toBe(852);
  await page.evaluate(() => {
    Object.assign(visualViewport!, { height: 426, width: 196.5, scale: 2, offsetTop: 50, offsetLeft: 20 });
    visualViewport!.dispatchEvent(new Event('resize'));
    visualViewport!.dispatchEvent(new Event('scroll'));
  });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await page.locator('.app-shell').boundingBox()).toEqual({ x: 0, y: 0, width: 393, height: 852 });
});
