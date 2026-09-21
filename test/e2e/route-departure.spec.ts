import { expect, test, type Page } from '@playwright/test';
import type { Map as MapLibreMap } from 'maplibre-gl';
import terminal from '../fixtures/route-departures.json' with { type: 'json' };
import catalog from '../fixtures/route-approaches.json' with { type: 'json' };

async function setup(page: Page, text = 'KSFO KSJC') {
  await page.route('**/route-approach-legs.json', route => route.fulfill({ json: terminal }));
  await page.route('**/route-approaches.json', route => route.fulfill({ json: catalog }));
  await page.addInitScript(text => {
    if (localStorage.getItem('zlayer-route-draft-v1')) return;
    localStorage.setItem('zlayer-route-draft-v1', JSON.stringify({ version: 2,
      entries: text.split(' ').map((text, index) => ({ id: `entry-${index}`, text })) }));
  }, text);
  await page.goto('/test/browser/routes.html?sid&map');
}
async function choose(page: Page) {
  await page.locator('.route-token').first().click();
  await page.getByRole('menuitem', { name: 'Choose SID…', exact: true }).click();
  await page.getByRole('button', { name: 'TRUKN2 · TRUKN TWO', exact: true }).click();
}
const hasPoint = (page: Page, ident: string) => page.evaluate(ident => {
  const map = (window as unknown as { approachMapAudit: MapLibreMap }).approachMapAudit;
  return !!map.getSource('route-plan') && map.querySourceFeatures('route-plan').some(feature => feature.properties.ident === ident);
}, ident);

for (const touch of [false, true]) test.describe(touch ? 'touch' : 'mouse', () => {
  test.use({ hasTouch: touch, viewport: { width: touch ? 390 : 1280, height: 900 } });
  test('SID preview, airport bundle, branch change and reload', async ({ page }, info) => {
    await setup(page);
    const before = await page.evaluate(() => localStorage.getItem('zlayer-route-draft-v1'));
    await choose(page);
    const picker = page.getByRole('dialog', { name: 'Choose runway and exit', exact: true });
    await expect(picker.getByRole('radio', { checked: true })).toHaveCount(0);
    await expect(picker.getByRole('button', { name: 'Add to route', exact: true })).toBeDisabled();
    await picker.getByRole('radio', { name: 'Runway 01L · TYDYE-TRUKN', exact: true }).check();
    await picker.getByRole('radio', { name: 'DEDHD', exact: true }).check();
    await expect.poll(() => hasPoint(page, 'TYDYE')).toBe(true);
    expect(await page.evaluate(() => localStorage.getItem('zlayer-route-draft-v1'))).toBe(before);
    await page.screenshot({ path: info.outputPath('sid-preview.png') });
    await page.keyboard.press('Escape');
    await expect(page.locator('.route-attached-departure')).toHaveCount(0);
    await expect.poll(() => hasPoint(page, 'TYDYE')).toBe(false);
    await choose(page);
    await picker.getByRole('radio', { name: 'Runway 01L · TYDYE-TRUKN', exact: true }).check();
    await picker.getByRole('radio', { name: 'DEDHD', exact: true }).check();
    await picker.getByRole('button', { name: 'Add to route', exact: true }).click();
    const bundle = page.locator('[data-route-entry="entry-0"]');
    await expect(bundle.locator('.route-token')).toHaveClass(/is-airports/);
    await expect(page.locator('.route-token strong')).toHaveText(['KSFO', 'KSJC']);
    await expect(bundle.locator('.route-attached-departure')).toHaveText('TRUKN2 · Runway 01L · DEDHD');
    await page.reload();
    await expect(bundle.locator('.route-attached-departure')).toHaveText('TRUKN2 · Runway 01L · DEDHD');
    await expect.poll(() => hasPoint(page, 'TYDYE')).toBe(true);
    await bundle.locator('.route-attached-departure').click();
    await page.getByRole('button', { name: 'Change runway / exit', exact: true }).click();
    await picker.getByRole('radio', { name: 'Runway 28R · TRUKN', exact: true }).check();
    await expect(picker.getByRole('button', { name: 'Replace SID', exact: true })).toBeDisabled();
    await picker.getByRole('radio', { name: 'DEDHD', exact: true }).check();
    await expect.poll(() => hasPoint(page, 'TYDYE')).toBe(false);
    await picker.getByRole('button', { name: 'Replace SID', exact: true }).click();
    await expect(bundle.locator('.route-token')).toHaveClass(/is-airports/);
    await page.screenshot({ path: info.outputPath('sid-bundle.png') });
    await page.getByRole('button', { name: 'Remove TRUKN2 SID from KSFO', exact: true }).click();
    await expect(page.locator('.route-attached-departure')).toHaveCount(0);
    await expect(page.locator('.route-token strong')).toHaveText(['KSFO', 'KSJC']);
  });
});

test('pasted SID becomes an airport attachment and selecting its runway clears the original warning', async ({ page }) => {
  await setup(page, 'KSFO TRUKN2 DEDHD KSJC');
  await expect(page.locator('.route-token strong')).toHaveText(['KSFO', 'DEDHD', 'KSJC']);
  await expect(page.locator('.route-attached-departure')).toHaveText('TRUKN2 · Choose branch · DEDHD');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('zlayer-route-draft-v1')!).entries.length)).toBe(3);
  await page.locator('.route-attached-departure').click();
  await page.getByRole('button', { name: 'Change runway / exit', exact: true }).click();
  await page.getByRole('radio', { name: 'Runway 01R · TYDYE-TRUKN', exact: true }).check();
  await page.getByRole('radio', { name: 'DEDHD', exact: true }).check();
  await page.getByRole('button', { name: 'Replace SID', exact: true }).click();
  await expect(page.locator('.route-token').first()).toHaveClass(/is-airports/);
  await expect(page.locator('.route-issues')).not.toContainText('runway/branch not selected');
  await page.reload();
  await expect(page.locator('.route-attached-departure')).toHaveText('TRUKN2 · Runway 01R · DEDHD');
});
