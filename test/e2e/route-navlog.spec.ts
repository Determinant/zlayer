import { expect, test, type Page } from '@playwright/test';
import { longRoute } from './route-editor-helpers';

async function showNavLog(page: Page) {
  await page.getByRole('button', { name: 'Route actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Show NavLog', exact: true }).click();
  await expect(page.getByRole('region', { name: 'NavLog', exact: true })).toBeVisible();
  await expect(page.locator('.route-navlog-reveal')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
}

test('route chips and NavLog retain distinct, matching waypoint type colors', async ({ page }, info) => {
  const entities = [
    ['KSFO', 'airports'], ['SUNOL', 'fixes'], ['OSI', 'navaids'], ['REIGA', 'ndb'], ['VPWAM', 'vfr-waypoints'],
  ] as const;
  await page.addInitScript(entities => localStorage.setItem('zlayer-plugin:routes:draft', JSON.stringify({ version: 2,
    entries: [...entities.map(([text], index) => ({ id: `color-${index}`, text })), { id: 'invalid', text: 'UNKNOWN' }],
  })), entities);
  await page.goto('/test/browser/routes.html?entities');
  await showNavLog(page);
  const colors: string[] = [];
  for (const [ident, type] of entities) {
    const chip = page.locator('.route-token').filter({ hasText: new RegExp(`^${ident}$`) });
    const waypoint = page.getByRole('rowheader', { name: ident, exact: true }).locator('strong');
    await expect(chip).toHaveClass(new RegExp(`\\bis-${type}\\b`));
    const color = await chip.evaluate(element => getComputedStyle(element).color);
    await expect(waypoint).toHaveCSS('color', color);
    colors.push(color);
  }
  expect(new Set(colors).size).toBe(entities.length);
  await expect(page.locator('.route-token.is-unresolved')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('.route-token.is-unresolved')).toHaveCSS('color', 'rgb(255, 178, 184)');
  await page.screenshot({ path: info.outputPath('route-entity-colors.png') });
});

test('NavLog follows edits and gaps, stays open on map interaction, and hides completely through the bezel or menu', async ({ page }, info) => {
  await page.goto('/test/browser/routes.html?map');
  const bar = page.locator('.route-bar'), before = (await bar.boundingBox())!;
  await expect(page.locator('.route-navlog-bezel')).toHaveCount(0);
  await showNavLog(page);
  const panel = page.getByRole('region', { name: 'NavLog', exact: true });
  await expect(panel.getByRole('cell', { name: 'Unmeasured segment', exact: true })).toBeVisible();
  await expect(panel.getByRole('columnheader', { name: 'Known NM', exact: true })).toBeVisible();
  await page.locator('.map-canvas').click({ position: { x: 850, y: 500 } });
  await expect(panel).toBeVisible();
  const input = page.getByRole('textbox', { name: 'Add route waypoint', exact: true });
  await input.fill('KNUQ');
  await input.press('Enter');
  await expect(panel.getByRole('rowheader', { name: 'KNUQ', exact: true })).toBeVisible();
  await expect(panel.getByRole('status')).toContainText('3 fixes');
  const bezel = page.getByRole('button', { name: 'Hide NavLog', exact: true });
  await bezel.click();
  await expect(panel).toBeHidden();
  await expect(page.locator('.route-navlog-bezel')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Route actions', exact: true })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Show NavLog', exact: true })).toHaveCount(0);
  expect((await bar.boundingBox())!.height).toBe(before.height);
  await showNavLog(page);
  await expect(page.getByLabel('NavLog rows', { exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(page.locator('.route-navlog-bezel')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Route actions', exact: true })).toBeFocused();
  await showNavLog(page);
  await page.screenshot({ path: info.outputPath('navlog-desktop.png') });
  await page.getByRole('button', { name: 'Route actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Hide NavLog', exact: true }).click();
  await expect(panel).toBeHidden();
  await expect(page.locator('.route-navlog-bezel')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Route actions', exact: true })).toBeFocused();
});

test('NavLog scrolls beneath sticky headings, retains its bezel, and fits narrow and short viewports', async ({ page }, info) => {
  await longRoute(page);
  await showNavLog(page);
  const scroll = page.getByLabel('NavLog rows', { exact: true });
  for (const size of [{ width: 1280, height: 900 }, { width: 320, height: 568 }, { width: 568, height: 320 }]) {
    await page.setViewportSize(size);
    await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(scroll).toHaveCSS('scrollbar-width', 'thin');
    await expect(scroll).toHaveCSS('scrollbar-color', 'rgba(119, 151, 172, 0.4) rgba(0, 0, 0, 0)');
    const bounds = await page.locator('.route-navlog').boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(size.width);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(size.height);
    const geometry = await scroll.evaluate(element => ({ client: element.clientWidth, scroll: element.scrollWidth,
      top: element.getBoundingClientRect().top, heading: element.querySelector('thead th')!.getBoundingClientRect().top }));
    expect(geometry.scroll).toBe(geometry.client);
    expect(Math.abs(geometry.heading - geometry.top)).toBeLessThan(1);
    await page.screenshot({ path: info.outputPath(`navlog-${size.width}x${size.height}.png`) });
  }
  await page.getByRole('button', { name: 'Hide NavLog', exact: true }).click();
  await expect(page.locator('.route-navlog-bezel')).toBeHidden();
});

test('empty routes remain useful and reduced motion still opens and closes cleanly', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/test/browser/routes.html');
  await page.getByRole('button', { name: 'Route actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Clear Route', exact: true }).click();
  await showNavLog(page);
  await expect(page.getByText('Add waypoints to build a NavLog.')).toBeVisible();
  await expect(page.locator('.route-navlog-reveal')).toHaveCSS('transition-duration', '1e-05s');
  const input = page.getByRole('textbox', { name: 'Add route waypoint', exact: true });
  await input.fill('KSFO KSJC');
  await input.press('Enter');
  await expect(page.getByRole('region', { name: 'NavLog', exact: true }).getByRole('rowheader')).toHaveCount(2);
  await expect(page.getByRole('region', { name: 'NavLog', exact: true }).getByRole('cell').filter({ hasText: /^\d{3}°M \/ \d{3}°T$/ })).toHaveCount(1);
  await page.getByRole('button', { name: 'Hide NavLog', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Route navigation log' })).toBeHidden();
});

test('route warnings remain readable above the open NavLog on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/test/browser/routes.html');
  await showNavLog(page);
  await page.locator('.route-summary summary').click();
  await page.locator('.route-issues li').first().click();
  await expect(page.getByRole('region', { name: 'NavLog', exact: true })).toBeVisible();
});

test.describe('touch NavLog', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  test('the bezel stays reachable with a full touch target', async ({ page }, info) => {
    await longRoute(page);
    await page.getByRole('button', { name: 'Route actions', exact: true }).tap();
    await page.getByRole('menuitem', { name: 'Show NavLog', exact: true }).tap();
    const bezel = page.getByRole('button', { name: 'Hide NavLog', exact: true });
    await expect(bezel).toHaveCSS('height', '44px');
    await expect(page.locator('.route-navlog-reveal')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
    await page.screenshot({ path: info.outputPath('navlog-touch.png') });
    await bezel.tap();
    await expect(page.getByRole('region', { name: 'NavLog', exact: true })).toBeHidden();
    await expect(page.locator('.route-navlog-bezel')).toBeHidden();
    await page.getByRole('button', { name: 'Route actions', exact: true }).tap();
    await page.getByRole('menuitem', { name: 'Show NavLog', exact: true }).tap();
    await expect(page.getByRole('region', { name: 'NavLog', exact: true })).toBeVisible();
  });
});
