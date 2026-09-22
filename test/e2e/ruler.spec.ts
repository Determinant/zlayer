import { expect, test, type Page, type Locator } from '@playwright/test';
import type { RulerLayer } from '../../src/layers/ruler/layer';
import { entryIds } from './route-editor-helpers';

declare global { interface Window { rulerAudit: { layer: RulerLayer } } }
test.use({ hasTouch: true });

const toggle = (page: Page) => page.getByRole('button', { name: 'Measure distance and bearing', exact: true });
const grip = (page: Page, endpoint: 'start' | 'end') => page.getByRole('button', { name: `Move ${endpoint} point ${endpoint === 'start' ? 'A' : 'B'}` });
const snapshot = (page: Page) => page.evaluate(() => window.rulerAudit.layer.getSnapshot());
const center = async (locator: Locator) => {
  const box = (await locator.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};
async function fixture(page: Page) {
  await page.goto('/test/browser/route-map.html?ruler');
  await page.waitForFunction(() => window.routeMapAudit?.map.getLayer('ruler-line'));
  await toggle(page).click();
}
async function mouseDrag(page: Page, locator: Locator, dx: number, dy: number, release = true) {
  const point = await center(locator);
  await page.mouse.move(point.x, point.y); await page.mouse.down();
  await page.mouse.move(point.x + dx, point.y + dy, { steps: 5 });
  if (release) await page.mouse.up();
}

test('mouse uses two clicks, grips preserve offsets, and measurement owns route gestures', async ({ page }) => {
  await fixture(page);
  // Start exactly on a route waypoint, where ordinary input would edit/select the route.
  const start = await page.evaluate(() => {
    const point = window.routeMapAudit.map.project([-120, 35]);
    return { x: point.x, y: point.y };
  });
  await page.mouse.click(start.x, start.y);
  await expect(grip(page, 'start')).toBeVisible();
  await expect(grip(page, 'end')).toBeHidden();
  await expect(page.locator('.ruler-prompt')).toHaveText('Choose end point B');
  await page.mouse.click(start.x + 200, start.y - 100);
  await expect(page.locator('.ruler-bearing')).toHaveText(/\d{3}°M/);
  await expect(page.locator('.ruler-true-bearing')).toHaveText(/\d{3}°T/);
  const before = await snapshot(page);
  const mapBefore = await page.evaluate(() => window.routeMapAudit.map.getCenter().toArray());
  const positionsBefore = await page.evaluate(() => {
    const s = window.rulerAudit.layer.getSnapshot();
    const point = window.routeMapAudit.map.project(s.end!);
    return [point.x, point.y];
  });
  const knob = await center(grip(page, 'end'));
  expect(Math.hypot(knob.x - positionsBefore[0]!, knob.y - positionsBefore[1]!)).toBeGreaterThan(40);
  await mouseDrag(page, grip(page, 'end'), 80, 50, false);
  const during = await snapshot(page);
  expect(during.start).toEqual(before.start);
  expect(during.end).not.toEqual(before.end);
  const end = await page.evaluate(() => {
    const point = window.routeMapAudit.map.project(window.rulerAudit.layer.getSnapshot().end!);
    return [point.x, point.y];
  });
  expect(end[0]! - positionsBefore[0]!).toBeCloseTo(80, 0);
  expect(end[1]! - positionsBefore[1]!).toBeCloseTo(50, 0);
  const movingKnob = await center(grip(page, 'end'));
  expect(movingKnob.x - end[0]!).toBeCloseTo(knob.x - positionsBefore[0]!, 0);
  expect(movingKnob.y - end[1]!).toBeCloseTo(knob.y - positionsBefore[1]!, 0);
  await page.mouse.up();
  expect(await page.evaluate(() => window.routeMapAudit.map.getCenter().toArray())).toEqual(mapBefore);
  const committed = await snapshot(page);
  await page.mouse.click(900, 700);
  expect(await snapshot(page)).toEqual(committed);
  await expect(page.getByLabel('Edits')).toHaveText('0');
  await expect(page.getByLabel('Selection')).toHaveText('None');
  await page.getByRole('button', { name: 'Close ruler', exact: true }).click();
  await expect(grip(page, 'end')).toBeHidden();
  await page.mouse.click(start.x, start.y);
  await expect(page.getByLabel('Selection')).toContainText('KSBA');
  await expect(page.getByRole('alert')).toBeEmpty();
});

test('touch creates B above A, then either grip can move without moving the map', async ({ page }, info) => {
  await page.setViewportSize({ width: 744, height: 1133 });
  await fixture(page);
  await page.touchscreen.tap(340, 550);
  const initial = await snapshot(page);
  expect(initial.touch).toBe(true);
  expect(initial.provisional).toBe(true);
  await expect(page.locator('.ruler-prompt')).toHaveText('Drag B to measure');
  const projected = await page.evaluate(() => {
    const s = window.rulerAudit.layer.getSnapshot(), map = window.routeMapAudit.map;
    const a = map.project(s.start!), b = map.project(s.end!);
    return { a: [a.x, a.y], b: [b.x, b.y], camera: map.getCenter().toArray() };
  });
  expect(projected.b[0]).toBeCloseTo(projected.a[0]!, 0);
  expect(projected.b[1]).toBeCloseTo(projected.a[1]! - 120, 0);
  const session = await page.context().newCDPSession(page);
  for (const endpoint of ['end', 'start'] as const) {
    const point = await center(grip(page, endpoint));
    const box = (await grip(page, endpoint).boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(48);
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x + 100, y: point.y + 60 }] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  await session.detach();
  const final = await snapshot(page);
  expect(final.provisional).toBe(false);
  expect(final.start).not.toEqual(initial.start);
  expect(final.end).not.toEqual(initial.end);
  expect(await page.evaluate(() => window.routeMapAudit.map.getCenter().toArray())).toEqual(projected.camera);
  await expect(page.locator('.ruler-bearing')).toHaveText(/\d{3}°M/);
  await page.screenshot({ path: info.outputPath('ruler-touch-portrait.png') });
  await page.setViewportSize({ width: 1133, height: 744 });
  expect(await snapshot(page)).toEqual(final);
  await expect(grip(page, 'start')).toBeVisible();
  await expect(grip(page, 'end')).toBeVisible();
  await page.screenshot({ path: info.outputPath('ruler-touch-landscape.png') });
});

test('pan and pinch never place points and keep existing endpoints anchored', async ({ page }) => {
  await fixture(page);
  const session = await page.context().newCDPSession(page);
  const pinch = async () => {
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 350, y: 600, id: 1 }, { x: 500, y: 600, id: 2 }] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 280, y: 600, id: 1 }, { x: 570, y: 600, id: 2 }] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForFunction(() => !window.routeMapAudit.map.isMoving());
  };
  const zoom = await page.evaluate(() => window.routeMapAudit.map.getZoom());
  await pinch();
  expect((await snapshot(page)).start).toBeNull();
  expect(await page.evaluate(() => window.routeMapAudit.map.getZoom())).toBeGreaterThan(zoom);
  await page.mouse.move(400, 700); await page.mouse.down();
  await page.mouse.move(480, 710, { steps: 5 }); await page.mouse.up();
  await page.waitForFunction(() => !window.routeMapAudit.map.isMoving());
  expect((await snapshot(page)).start).toBeNull();
  await page.touchscreen.tap(600, 430);
  const fixed = await snapshot(page);
  await pinch();
  expect(await snapshot(page)).toEqual(fixed);
  await session.detach();
});

for (const reason of ['Escape', 'blur', 'outside', 'second finger'] as const) {
  test(`${reason} cancels a grip drag without committing its preview`, async ({ page }) => {
    await fixture(page);
    await page.touchscreen.tap(500, 450);
    const before = await snapshot(page);
    await mouseDrag(page, grip(page, 'end'), 80, 40, false);
    expect((await snapshot(page)).end).not.toEqual(before.end);
    if (reason === 'Escape') await page.keyboard.press('Escape');
    if (reason === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    if (reason === 'outside') await page.mouse.move(-20, 400);
    if (reason === 'second finger') {
      const session = await page.context().newCDPSession(page);
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 200, y: 650 }] });
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await session.detach();
    }
    await page.mouse.up();
    expect(await snapshot(page)).toEqual(before);
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => window.routeMapAudit.map.dragPan.isEnabled() && window.routeMapAudit.map.touchZoomRotate.isEnabled())).toBe(true);
  });
}

for (const interruption of ['touch cancel', 'second finger'] as const) {
  test(`${interruption} rolls back a real touch drag and leaves the next grip usable`, async ({ page }) => {
    await fixture(page);
    await page.touchscreen.tap(500, 450);
    const before = await snapshot(page), point = await center(grip(page, 'end'));
    const session = await page.context().newCDPSession(page);
    const moved = { x: point.x + 70, y: point.y + 40, id: 1 };
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, id: 1 }] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [moved] });
    expect((await snapshot(page)).end).not.toEqual(before.end);
    if (interruption === 'touch cancel') {
      await session.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    } else {
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [moved, { x: 200, y: 650, id: 2 }] });
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
    expect(await snapshot(page)).toEqual(before);
    const next = await center(grip(page, 'end'));
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...next, id: 1 }] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: next.x + 30, y: next.y + 20, id: 1 }] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    expect((await snapshot(page)).end).not.toEqual(before.end);
    expect((await snapshot(page)).provisional).toBe(false);
    await session.detach();
  });
}

test('reverse, keyboard adjustment, restart and Escape have explicit effects', async ({ page }) => {
  await fixture(page);
  await page.mouse.click(400, 450); await page.mouse.click(700, 400);
  const before = await snapshot(page);
  await page.getByRole('button', { name: 'Reverse ruler direction' }).click();
  const reversed = await snapshot(page);
  expect(reversed.start).toEqual(before.end);
  expect(reversed.end).toEqual(before.start);
  await grip(page, 'start').focus(); await page.keyboard.press('ArrowRight');
  expect((await snapshot(page)).start).not.toEqual(reversed.start);
  await page.getByRole('button', { name: 'New measurement' }).click();
  expect((await snapshot(page)).start).toBeNull();
  await expect(page.locator('.ruler-prompt')).toHaveText('Choose start point A');
  await page.keyboard.press('Escape');
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle(page)).toBeFocused();
  expect(await page.evaluate(() => window.routeMapAudit.map.doubleClickZoom.isEnabled())).toBe(true);
});

test('missing magnetic data keeps true bearing available and leaves magnetic bearing empty', async ({ page }) => {
  await page.route('**/nav/magnetic-model.json*', route => route.abort());
  await fixture(page);
  await page.mouse.click(400, 450); await page.mouse.click(700, 400);
  await expect(page.locator('.ruler-bearing')).toHaveText('—');
  await expect(page.locator('.ruler-true-bearing')).toHaveText(/\d{3}°T/);
  await expect(page.locator('.ruler-reference')).toHaveText('Magnetic bearing unavailable');
});

async function workspaceRulerWithRoute(page: Page) {
  await page.addInitScript(() => localStorage.setItem('zlayer-plugin:routes:draft', JSON.stringify({ version: 2,
    entries: ['350000N1200000W', '350000N1190000W', '360000N1190000W']
      .map((text, index) => ({ id: `ruler-entry-${index}`, text })),
  })));
  await page.goto('/');
  await expect(page.locator('.startup-screen')).toHaveCount(0);
  await expect(page.locator('.route-token')).toHaveCount(3);
  await expect(page.locator('.route-token.is-pending')).toHaveCount(0);
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
}

for (const control of ['route menu', 'NavLog', 'waypoint menu'] as const) {
  test(`Escape dismisses the ${control} while preserving the active ruler`, async ({ page }) => {
    await workspaceRulerWithRoute(page);
    if (control === 'waypoint menu') await page.locator('.route-token').first().click();
    else {
      await page.getByRole('button', { name: 'Route actions', exact: true }).click();
      if (control === 'NavLog') await page.getByRole('menuitem', { name: 'Show NavLog', exact: true }).click();
    }
    const panel = control === 'route menu' ? page.getByRole('menu', { name: 'Route actions', exact: true })
      : control === 'NavLog' ? page.getByRole('region', { name: 'NavLog', exact: true }) : page.locator('.route-token-menu');
    await expect(panel).toBeVisible();
    const focus = control === 'route menu' ? page.getByRole('menuitem', { name: 'Show NavLog', exact: true })
      : control === 'NavLog' ? page.getByLabel('NavLog rows', { exact: true })
        : panel.getByRole('menuitem').first();
    await expect(focus).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  });
}

test('Escape cancels a route reorder before the ruler fallback and release cannot commit it', async ({ page }) => {
  await workspaceRulerWithRoute(page);
  await page.clock.install();
  const source = page.locator('.route-token').first(), before = await entryIds(page);
  const start = await center(source), end = await center(page.locator('.route-token').nth(2));
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.clock.runFor(500);
  await expect(source).toHaveClass(/is-dragging/);
  await page.mouse.move(end.x, end.y, { steps: 5 });
  await page.keyboard.press('Escape');
  await expect(source).not.toHaveClass(/is-dragging/);
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.up();
  expect(await entryIds(page)).toEqual(before);
  await expect(page.locator('.route-token-menu')).toHaveCount(0);
  await toggle(page).focus();
  await page.keyboard.press('Escape');
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
});

for (const size of [{ width: 320, height: 568 }, { width: 744, height: 1133 }, { width: 1133, height: 744 }]) {
  test(`workspace ruler sits below Layers and fits at ${size.width}×${size.height}`, async ({ page }, info) => {
    await page.setViewportSize(size);
    await page.goto('/');
    await expect(toggle(page)).toBeEnabled();
    // The default terrain toolbox covers the center of a 320px map.
    const terrain = page.getByRole('button', { name: 'Hide terrain toolbox', exact: true });
    if (await terrain.isVisible()) await terrain.click();
    const layers = (await page.getByRole('button', { name: 'Open map layers', exact: true }).boundingBox())!;
    const ruler = (await toggle(page).boundingBox())!;
    expect(ruler.x).toBe(layers.x);
    expect(ruler.y).toBe(layers.y + layers.height + 9);
    await toggle(page).tap();
    const map = (await page.getByLabel('Aviation chart map').boundingBox())!;
    await page.touchscreen.tap(map.x + map.width * .5, map.y + map.height * .55);
    await expect(grip(page, 'end')).toBeVisible();
    await expect(page.locator('.ruler-bearing')).toHaveText(/\d{3}°M/);
    await expect(page.locator('.ruler-true-bearing')).toHaveText(/\d{3}°T/);
    const magneticBearing = (await page.locator('.ruler-bearing').boundingBox())!;
    const trueBearing = (await page.locator('.ruler-true-bearing').boundingBox())!;
    expect(trueBearing.y).toBeGreaterThanOrEqual(magneticBearing.y + magneticBearing.height);
    expect(trueBearing.x + trueBearing.width).toBeCloseTo(magneticBearing.x + magneticBearing.width, 0);
    const card = (await page.getByRole('region', { name: 'Ruler measurement' }).boundingBox())!;
    expect(card.x).toBeGreaterThanOrEqual(map.x);
    expect(card.x + card.width).toBeLessThanOrEqual(map.x + map.width);
    for (const control of await page.locator('.ruler-actions button').all()) {
      const box = (await control.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('ruler-workspace.png') });
  });
}
