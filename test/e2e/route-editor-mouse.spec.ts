import { expect, test } from '@playwright/test';
import { longRoute, entryIds, scrollLeft, center } from './route-editor-helpers';

for (const width of [820, 1280]) {
  test(`mouse dragging scrolls a long route and stays a scroll after pausing at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.clock.install();
    const editor = await longRoute(page), tokens = page.locator('.route-token');
    const ids = await entryIds(page), start = await center(tokens.nth(3));
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x - 100, start.y, { steps: 5 });
    expect(await scrollLeft(editor)).toBeCloseTo(100, 0);
    await page.clock.runFor(700);
    await expect(page.locator('.route-token.is-dragging')).toHaveCount(0);
    await page.mouse.move(start.x - 150, start.y, { steps: 4 });
    await page.mouse.up();
    expect(await scrollLeft(editor)).toBeCloseTo(150, 0);
    await expect(editor).not.toHaveClass(/is-scrolling/);
    await expect(page.locator('.route-token-menu')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Add route waypoint', exact: true })).not.toBeFocused();
    expect(await entryIds(page)).toEqual(ids);

    const back = await center(tokens.nth(3));
    await page.mouse.move(back.x, back.y);
    await page.mouse.down();
    await page.mouse.move(back.x + 100, back.y, { steps: 5 });
    await page.mouse.up();
    expect(await scrollLeft(editor)).toBeCloseTo(50, 0);
    await tokens.nth(3).click();
    await expect(page.getByRole('menuitem', { name: 'Replace route item', exact: true })).toBeVisible();
  });
}

test('dragging from a strip gap scrolls without selecting text or focusing the typing field', async ({ page }) => {
  await page.clock.install();
  const editor = await longRoute(page), tokens = page.locator('.route-token');
  const ids = await entryIds(page), box = (await tokens.nth(3).boundingBox())!;
  const start = { x: box.x + box.width + 2, y: box.y + box.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.clock.runFor(700);
  await page.mouse.move(start.x - 120, start.y, { steps: 6 });
  await page.mouse.up();
  expect(await scrollLeft(editor)).toBeCloseTo(120, 0);
  expect(await entryIds(page)).toEqual(ids);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('');
  await expect(page.getByRole('textbox', { name: 'Add route waypoint', exact: true })).not.toBeFocused();
  await expect(page.locator('.route-token-menu')).toHaveCount(0);
  // A subsequent click in a gap can still focus the field.
  const next = (await tokens.nth(4).boundingBox())!;
  await page.mouse.click(next.x + next.width + 2, next.y + next.height / 2);
  await expect(page.getByRole('textbox', { name: 'Add route waypoint', exact: true })).toBeFocused();
});

test('a held airport and approach reorder across the entire strip using edge scrolling', async ({ page }, testInfo) => {
  await page.clock.install();
  const editor = await longRoute(page, true), bundle = page.locator('[data-route-entry="entry-0"]');
  const source = bundle.locator('.route-token'), start = await center(source);
  const bounds = (await editor.boundingBox())!, maximum = await editor.evaluate(element => element.scrollWidth - element.clientWidth);
  const ids = await entryIds(page);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.clock.runFor(500);
  await expect(source).toHaveClass(/is-dragging/);
  // Releasing a stationary hold never moves the route or opens actions.
  await page.mouse.up();
  expect(await entryIds(page)).toEqual(ids);
  await expect(page.locator('.route-token-menu')).toHaveCount(0);
  await page.mouse.down();
  await page.clock.runFor(500);
  await page.mouse.move(bounds.x + bounds.width - 5, start.y, { steps: 6 });
  await page.clock.runFor(600);
  const firstScroll = await scrollLeft(editor);
  expect(firstScroll).toBeGreaterThan(100);
  await page.clock.runFor(600);
  expect(await scrollLeft(editor)).toBeGreaterThan(firstScroll);
  await editor.screenshot({ path: testInfo.outputPath('mouse-edge-scroll.png') });
  await page.clock.runFor(5000);
  expect(await scrollLeft(editor)).toBeCloseTo(maximum, 0);
  await page.mouse.up();
  expect((await entryIds(page)).at(-1)).toBe('entry-0');
  await expect(bundle.locator('.route-attached-approach')).toContainText('ARCHI');
  await expect(page.locator('.route-token-menu')).toHaveCount(0);
  const stopped = await scrollLeft(editor);
  await page.clock.runFor(500);
  expect(await scrollLeft(editor)).toBe(stopped);
  // Existing approach controls remain clickable after the drag.
  await bundle.locator('.route-attached-approach').click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('Escape cancels a mouse reorder and releasing outside the strip cannot commit it', async ({ page }) => {
  await page.clock.install();
  const editor = await longRoute(page), source = page.locator('.route-token').first();
  const ids = await entryIds(page), start = await center(source), box = (await editor.boundingBox())!;
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.clock.runFor(500);
  await page.mouse.move(box.x + box.width - 5, start.y, { steps: 6 });
  await page.clock.runFor(600);
  await page.keyboard.press('Escape');
  const stopped = await scrollLeft(editor);
  await page.clock.runFor(600);
  expect(await scrollLeft(editor)).toBe(stopped);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height + 30);
  await page.mouse.up();
  expect(await entryIds(page)).toEqual(ids);
  await expect(page.locator('.route-token.is-dragging')).toHaveCount(0);
  await expect(page.locator('.route-token-menu')).toHaveCount(0);
});

test('mouse text selection stays native inside the typing field', async ({ page }) => {
  await page.goto('/test/browser/routes.html');
  const editor = page.locator('.route-editor'), input = page.getByRole('textbox', { name: 'Add route waypoint', exact: true });
  await input.fill('KSQL');
  const box = (await input.boundingBox())!, before = await scrollLeft(editor);
  await page.mouse.move(box.x + 5, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 65, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  expect(await input.evaluate(element => {
    const field = element as HTMLInputElement;
    return (field.selectionEnd ?? 0) - (field.selectionStart ?? 0);
  })).toBeGreaterThan(0);
  await expect(input).toHaveValue('KSQL');
  expect(await scrollLeft(editor)).toBe(before);
  await expect(editor).not.toHaveClass(/is-scrolling/);
  await expect(page.locator('.route-token.is-dragging')).toHaveCount(0);
});

test('reordering uses the release position when the last pointer move was coalesced', async ({ page }) => {
  await page.clock.install();
  await longRoute(page);
  const source = page.locator('[data-route-entry="entry-0"] .route-token');
  const ids = await entryIds(page), start = await center(source);
  const end = await center(page.locator('[data-route-entry="entry-2"] .route-token'));
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.clock.runFor(500);
  await expect(source).toHaveClass(/is-dragging/);
  await source.dispatchEvent('pointerup', { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0,
    clientX: end.x, clientY: end.y });
  await page.mouse.up();
  expect(await entryIds(page)).toEqual([ids[1], ids[2], ids[0], ...ids.slice(3)]);
  await expect(page.locator('.route-token.is-dragging')).toHaveCount(0);
  await expect(page.locator('.route-token-menu')).toHaveCount(0);
});
