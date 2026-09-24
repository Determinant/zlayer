import { expect, type Page } from '@playwright/test';

/** Choose exposed map pixels beside the open toolbox, including phone layouts. */
export async function weatherMapPoint(page: Page) {
  const canvas = page.locator('.maplibregl-canvas'), box = (await canvas.boundingBox())!;
  const openToolbox = page.locator('.map-edge-awc.is-open');
  const toolbox = await openToolbox.isVisible() ? await openToolbox.boundingBox() : null;
  return { x: toolbox ? Math.max(box.x + box.width / 2, toolbox.x + toolbox.width + 20) : box.x + box.width / 2,
    y: box.y + box.height / 2 };
}

export async function openWeatherMenu(page: Page, touch = false) {
  const point = await weatherMapPoint(page);
  const menu = page.getByRole('menu', { name: 'Map actions' });
  if (!touch) await page.mouse.click(point.x, point.y, { button: 'right' });
  else if (page.context().browser()?.browserType().name() === 'chromium') {
    const session = await page.context().newCDPSession(page);
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await expect(menu).toBeVisible();
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await session.detach();
  } else {
    const dispatch = (type: string) => page.locator('.maplibregl-canvas').evaluate((canvas, { type, point }) => {
      // Desktop WebKit exposes Touch but does not allow constructing it.
      const touch = { identifier: 1, target: canvas, clientX: point.x, clientY: point.y };
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        changedTouches: { value: [touch] }, touches: { value: type === 'touchstart' ? [touch] : [] },
        targetTouches: { value: type === 'touchstart' ? [touch] : [] },
      });
      canvas.dispatchEvent(event);
    }, { type, point });
    await dispatch('touchstart'); await expect(menu).toBeVisible(); await dispatch('touchend');
  }
  await expect(menu.getByRole('menuitem', { name: 'Inspect weather', exact: true })).toBeVisible();
  return menu;
}

export async function inspectWeather(page: Page) {
  const show = page.getByRole('button', { name: 'Show AWC Weather toolbox', exact: true });
  if (await show.count()) await show.click();
  const details = page.getByRole('button', { name: 'Hide Weather advisory details', exact: true });
  if (await details.count()) await details.click();
  const menu = await openWeatherMenu(page);
  await menu.getByRole('menuitem', { name: 'Inspect weather', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Weather advisory details' })).toBeVisible();
}
