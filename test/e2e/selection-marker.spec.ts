import { expect, test, type Page } from '@playwright/test';
import { selectNavigationResult as search } from './navigation-search';
import { openSidePanel } from './side-panel-fixture';

const marker = (page: Page) => page.locator('.selection-marker');

for (const touch of [false, true]) test.describe(`selection focus (${touch ? 'touch' : 'mouse'})`, () => {
  test.use({ hasTouch: touch, viewport: touch ? { width: 390, height: 844 } : { width: 1280, height: 900 } });

  test('entity focus follows the map and the unstowed panel, retaining its identifier', async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      if (localStorage.getItem('selection-fixture')) return;
      localStorage.setItem('selection-fixture', 'true');
      localStorage.setItem('zlayers-map-view-v1', JSON.stringify({ version: 1, center: [-118.45, 34.02], zoom: 12 }));
      localStorage.setItem('zlayer-ui:edge-tool', JSON.stringify({ version: 1, value: null }));
      localStorage.setItem('zlayers-map-preferences-v1', JSON.stringify({ version: 2, chartBase: '', terrainEnabled: false, ownshipEnabled: false }));
    });
    await page.goto('/');
    await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false');
    const canvas = page.locator('.maplibregl-canvas');
    const bounds = (await canvas.boundingBox())!;
    const click = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    if (touch) await page.touchscreen.tap(click.x, click.y);
    else await page.mouse.click(click.x, click.y);
    await expect(page.locator('.feature-card h2')).toHaveText('KSMO');
    await expect(marker(page)).toHaveCount(1);
    await expect(marker(page).locator('.selection-marker-label')).toHaveText('KSMO');
    const centered = (await marker(page).boundingBox())!;
    expect(centered.x + centered.width / 2).toBeCloseTo(click.x, 0);
    expect(centered.y + centered.height / 2).toBeCloseTo(click.y, 0);
    expect(await marker(page).evaluate(element => getComputedStyle(element).pointerEvents)).toBe('none');

    // Pan into exposed map space; phone details cover most of the map center.
    await page.locator('.side-panels').evaluate(element =>
      Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)));
    const pan = async (x: number, y: number, dx: number, dy: number) => {
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + dx, y + dy, { steps: 20 });
      await page.mouse.up();
    };
    if (touch) {
      await pan(bounds.x + 48, bounds.y + 400, 0, -(bounds.height / 2 - 36));
      await pan(bounds.x + 150, bounds.y + 36, -(bounds.width / 2 - 100), 0);
    } else await pan(bounds.x + 90, bounds.y + 110, 0, -90);
    await expect.poll(async () => (await marker(page).boundingBox())!.y).toBeLessThan(centered.y - 50);
    await expect(marker(page).locator('.selection-marker-label')).toBeVisible();
    await marker(page).locator('.selection-marker-label').click();
    await expect(page.locator('.feature-card h2')).toHaveText('KSMO');
    await page.screenshot({ path: testInfo.outputPath('selected-airport.png') });

    await page.getByRole('button', { name: 'Hide KSMO details', exact: true }).click();
    await expect(marker(page)).toHaveCount(0);
    await page.reload();
    await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false');
    await expect(marker(page)).toHaveCount(0);
    await page.getByRole('button', { name: 'Show KSMO details', exact: true }).click();
    await expect(marker(page).locator('.selection-marker-label')).toHaveText('KSMO');
    await page.reload();
    await expect(marker(page).locator('.selection-marker-label')).toHaveText('KSMO');

    // A route airport uses the same single focus identifier.
    await page.getByRole('button', { name: 'Add KSMO to end of route', exact: true }).click();
    await expect(page.locator('.route-token')).toHaveCount(1);
    await expect(marker(page)).toHaveCount(1);
    await expect(marker(page).locator('.selection-marker-label')).toHaveText('KSMO');
    await search(page, 'KSBA');
    await expect(marker(page).locator('.selection-marker-label')).toHaveText('KSBA');
    await page.getByRole('tab', { name: 'Plates', exact: true }).click();
    await page.getByRole('button', { name: /TEST APPROACH/ }).click();
    await expect(page.locator('.procedure-page-stage')).toHaveAttribute('aria-busy', 'false');
    await expect(marker(page)).toHaveCount(0);
    await openSidePanel(page, 'details');
    await expect(marker(page)).toHaveCount(1);
    await page.getByRole('button', { name: 'Close detail', exact: true }).click();
    await expect(marker(page)).toHaveCount(0);

    await search(page, 'CMA');
    await expect(page.locator('.feature-card h2')).toHaveText('CMA');
    await expect(marker(page)).toHaveCount(1);
    await expect(marker(page).locator('.selection-marker-label')).toHaveText('CMA');
    await expect(marker(page).locator('.selection-marker-label')).toBeVisible();
    await page.getByRole('button', { name: 'Hide CMA details', exact: true }).click();
    await expect(marker(page)).toHaveCount(0);
    await page.getByRole('button', { name: 'Show CMA details', exact: true }).click();
    await expect(marker(page).locator('.selection-marker-label')).toHaveText('CMA');
    await page.getByLabel('Settings and offline downloads').click();
    await page.getByRole('tab', { name: 'Plugins', exact: true }).click();
    const navigation = page.locator('.plugin-row[data-plugin="navigation"]').getByRole('switch');
    await navigation.click();
    await expect(marker(page)).toHaveCount(0);
    await navigation.click();
    await expect(marker(page).locator('.selection-marker-label')).toHaveText('CMA');
    await page.getByLabel('Close settings').click();
    await page.getByRole('button', { name: 'Close detail', exact: true }).click();
    await expect(marker(page)).toHaveCount(0);
    await expect(page.locator('.map-runtime-error')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

test('map menus remain clickable where they overlap an open detail panel', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem('zlayers-map-view-v1', JSON.stringify({ version: 1, center: [-118.45, 34.02], zoom: 12 }));
    localStorage.setItem('zlayer-ui:edge-tool', JSON.stringify({ version: 1, value: null }));
    localStorage.setItem('zlayers-map-preferences-v1', JSON.stringify({ version: 2, chartBase: '', terrainEnabled: false, ownshipEnabled: false }));
  });
  await page.goto('/');
  await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false');
  const canvas = (await page.locator('.maplibregl-canvas').boundingBox())!;
  const center = { x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2 };
  await page.mouse.click(center.x, center.y);
  await expect(page.locator('.feature-card h2')).toHaveText('KSMO');
  await page.locator('.side-panels').evaluate(element => Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)));
  await page.mouse.click(center.x, center.y, { button: 'right' });
  const picker = page.locator('.nearby-feature-picker');
  await expect(picker).toBeVisible();
  const choice = picker.locator('.nearby-feature-picker-list button').filter({ hasText: 'KSMO' });
  await expect(choice).toBeVisible();
  const button = (await choice.boundingBox())!, card = (await page.locator('.feature-card').boundingBox())!;
  const overlap = { x: Math.max(button.x, card.x) + 5, y: button.y + button.height / 2 };
  expect(overlap.x).toBeLessThan(Math.min(button.x + button.width, card.x + card.width));
  expect(await page.evaluate(point => !!document.elementFromPoint(point.x, point.y)?.closest('.nearby-feature-picker'), overlap)).toBe(true);
  await page.mouse.click(overlap.x, overlap.y);
  await expect(picker).toHaveCount(0);
  await expect(page.locator('.feature-card h2')).toHaveText('KSMO');
  await page.getByRole('button', { name: 'Open map layers', exact: true }).click();
  const layers = (await page.locator('.layer-popover').boundingBox())!;
  const covered = { x: Math.max(layers.x, card.x) + 20, y: Math.max(layers.y, card.y) + 20 };
  expect(covered.y).toBeLessThan(Math.min(layers.y + layers.height, card.y + card.height));
  expect(await page.evaluate(point => !!document.elementFromPoint(point.x, point.y)?.closest('.layer-popover'), covered)).toBe(true);
  await page.getByRole('button', { name: 'Close map layers', exact: true }).click();
});
