import { expect, test } from '@playwright/test';
import { longRoute, entryIds, scrollLeft, center } from './route-editor-helpers';

test.use({ hasTouch: true, isMobile: true });

for (const width of [390, 820]) {
  test(`swiping a waypoint scrolls, stays a scroll after a pause, and a fresh tap opens actions at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.clock.install();
    const editor = await longRoute(page), tokens = page.locator('.route-token');
    const ids = await entryIds(page);
    const start = await center(tokens.nth(width === 390 ? 3 : 6));
    const touch = await page.context().newCDPSession(page);
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
    for (const delta of [20, 50, 90, 140]) {
      await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start.x - delta, y: start.y }] });
    }
    await expect.poll(() => scrollLeft(editor)).toBeGreaterThan(50);
    await page.clock.runFor(700);
    await expect(page.locator('.route-token.is-dragging')).toHaveCount(0);
    await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start.x - 170, y: start.y }] });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await touch.detach();
    await expect(page.locator('.route-token-menu')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Add route waypoint', exact: true })).not.toBeFocused();
    expect(await entryIds(page)).toEqual(ids);
    await tokens.nth(6).tap();
    await expect(page.getByRole('menuitem', { name: 'Replace route item', exact: true })).toBeVisible();
  });

  test(`hold then drag reorders once, without scrolling or opening a menu at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/test/browser/routes.html');
    const tokens = page.locator('.route-token'), editor = page.locator('.route-editor');
    const ids = await entryIds(page), initialScroll = await scrollLeft(editor);
    const start = await center(tokens.first()), end = await center(tokens.last());
    const touch = await page.context().newCDPSession(page);
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
    await expect(tokens.first()).toHaveClass(/is-dragging/);
    await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [end] });
    await expect(tokens.first()).toHaveClass(/is-dragging/);
    expect(await scrollLeft(editor)).toBe(initialScroll);
    await editor.screenshot({ path: testInfo.outputPath('held-waypoint.png') });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await touch.detach();
    await expect.poll(() => entryIds(page)).toEqual([ids[1], ids[2], ids[0]]);
    await expect(page.locator('.route-token-menu')).toHaveCount(0);
    await expect(page.locator('.route-token.is-dragging')).toHaveCount(0);
    await tokens.last().tap();
    await expect(page.getByRole('menuitem', { name: 'Replace route item', exact: true })).toBeVisible();
  });
}

test('holding a dragged waypoint at the edge scrolls continuously to distant positions', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.install();
  const editor = await longRoute(page), source = page.locator('.route-token').first();
  const maximum = await editor.evaluate(element => element.scrollWidth - element.clientWidth);
  const start = await center(source), box = (await editor.boundingBox())!;
  const edge = { x: box.x + box.width - 5, y: start.y };
  const touch = await page.context().newCDPSession(page);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
  await page.clock.runFor(500);
  await expect(source).toHaveClass(/is-dragging/);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [edge] });
  await page.clock.runFor(600);
  const firstScroll = await scrollLeft(editor);
  expect(firstScroll).toBeGreaterThan(100);
  await page.clock.runFor(600);
  expect(await scrollLeft(editor)).toBeGreaterThan(firstScroll + 100);
  await editor.screenshot({ path: testInfo.outputPath('edge-scroll.png') });
  await page.clock.runFor(5000);
  expect(await scrollLeft(editor)).toBeCloseTo(maximum, 0);
  await page.clock.runFor(500);
  expect(await scrollLeft(editor)).toBeCloseTo(maximum, 0);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await touch.detach();
  expect((await entryIds(page)).indexOf('entry-0')).toBeGreaterThan(4);
  const stopped = await scrollLeft(editor);
  await page.clock.runFor(500);
  expect(await scrollLeft(editor)).toBe(stopped);
  await expect(page.locator('.route-token-menu')).toHaveCount(0);
});

test('an attached approach scrolls naturally and stays with its airport when reordered', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.install();
  const editor = await longRoute(page, true), bundle = page.locator('[data-route-entry="entry-0"]');
  const ids = await entryIds(page), approach = bundle.locator('.route-attached-approach');
  await expect(approach).toContainText('ARCHI');
  const start = await center(approach), touch = await page.context().newCDPSession(page);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
  for (const delta of [20, 40, 60]) {
    await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start.x - delta, y: start.y }] });
  }
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(() => scrollLeft(editor)).toBeGreaterThan(10);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await entryIds(page)).toEqual(ids);

  await bundle.locator('.route-token').scrollIntoViewIfNeeded();
  const airport = await center(bundle.locator('.route-token')), box = (await editor.boundingBox())!;
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [airport] });
  await page.clock.runFor(500);
  await expect(bundle).toHaveClass(/is-entry-dragging/);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x + box.width - 5, y: airport.y }] });
  await page.clock.runFor(1000);
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await touch.detach();
  expect((await entryIds(page)).indexOf('entry-0')).toBeGreaterThan(2);
  await expect(bundle.locator('.route-attached-approach')).toContainText('ARCHI');
  await expect(bundle.locator('.route-token strong')).toHaveText('KSFO');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  await expect(bundle.locator('.route-attached-approach')).toContainText('ARCHI');
  expect((await entryIds(page)).indexOf('entry-0')).toBeGreaterThan(2);
});

test('a second finger or touch cancellation aborts a reorder without changing the route', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/test/browser/routes.html');
  const tokens = page.locator('.route-token'), ids = await entryIds(page);
  const start = await center(tokens.first()), end = await center(tokens.last());
  const touch = await page.context().newCDPSession(page);
  for (const secondFinger of [false, true]) {
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...start, id: 0 }] });
    await expect(tokens.first()).toHaveClass(/is-dragging/);
    await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...end, id: 0 }] });
    if (secondFinger) {
      await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...end, id: 0 }, { x: end.x, y: end.y + 80, id: 1 }] });
      await expect(page.locator('.route-token.is-dragging')).toHaveCount(0);
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else await touch.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    expect(await entryIds(page)).toEqual(ids);
    await expect(page.locator('.route-token.is-dragging')).toHaveCount(0);
    await expect(page.locator('.route-token-menu')).toHaveCount(0);
  }
  await touch.detach();
});

test('a mouse uses hold then drag to reorder on a touch-capable iPad layout', async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 1000 });
  await page.goto('/test/browser/routes.html');
  const tokens = page.locator('.route-token'), ids = await entryIds(page);
  const start = await center(tokens.first()), end = await center(tokens.last());
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await expect(tokens.first()).toHaveClass(/is-dragging/);
  await page.mouse.move(end.x, end.y, { steps: 4 });
  await expect(tokens.first()).toHaveClass(/is-dragging/);
  await page.mouse.up();
  await expect.poll(() => entryIds(page)).toEqual([ids[1], ids[2], ids[0]]);
  await expect(page.locator('.route-token-menu')).toHaveCount(0);
});
