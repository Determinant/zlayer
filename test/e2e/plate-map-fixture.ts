import { expect, type Page } from '@playwright/test';

/** A ready overlay retains its selection without a persistent status banner. */
export async function expectMapPlate(page: Page, name: string | null = 'TEST APPROACH') {
  await expect.poll(() => page.evaluate(() =>
    JSON.parse(localStorage.getItem('zlayer-ui:plate-on-map') ?? 'null')?.value?.procedure.name ?? null,
  )).toBe(name);
  await expect(page.getByLabel('IAP on map', { exact: true })).toHaveCount(0);
}

/** The caller has positioned the map with the plate at its visible center. */
export async function hideMapPlate(page: Page) {
  await page.locator('.maplibregl-canvas').click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'IAP actions' });
  await menu.getByRole('menuitem', { name: 'Hide IAP from map' }).click();
  await expect(menu).toHaveCount(0);
  await expectMapPlate(page, null);
}
