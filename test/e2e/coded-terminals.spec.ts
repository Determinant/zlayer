import { expect, test, type Page } from '@playwright/test';
import type { Map as MapLibreMap } from 'maplibre-gl';
import terminal from '../fixtures/coded-terminal-procedures.json' with { type: 'json' };
import catalog from '../fixtures/route-approaches.json' with { type: 'json' };
import approaches from '../fixtures/route-approach-legs.json' with { type: 'json' };

async function showPath(page: Page, ident: string, coordinate: [number, number]) {
  // The test fixture has a fixed camera; production fits previews automatically.
  await page.evaluate(coordinate => {
    const map = (window as unknown as { approachMapAudit: MapLibreMap }).approachMapAudit;
    map.jumpTo({ center: coordinate, zoom: 8 });
  }, coordinate);
  await expect.poll(() => page.evaluate(ident => {
    const map = (window as unknown as { approachMapAudit: MapLibreMap }).approachMapAudit;
    return map.querySourceFeatures('route-plan').some(f => String(f.properties.ident).startsWith(ident));
  }, ident)).toBe(true);
}

for (const touch of [false, true]) test.describe(touch ? 'touch' : 'mouse', () => {
  test.use({ hasTouch: touch, viewport: { width: touch ? 390 : 1280, height: 900 } });
  test('coded SID and STAR preview, restrictions, airport attachment and reload', async ({ page }, info) => {
    await page.route('**/route-approach-legs.json', route => route.fulfill({ json: terminal }));
    await page.route('**/route-approaches.json', route => route.fulfill({ json: catalog }));
    await page.addInitScript(() => {
      if (!localStorage.getItem('zlayer-plugin:routes:draft')) localStorage.setItem('zlayer-plugin:routes:draft', JSON.stringify({ version: 2,
        entries: ['KSJC', 'KSNA'].map((text, i) => ({ id: `coded-${i}`, text })) }));
    });
    await page.goto('/test/browser/routes.html?sid&coded&map');
    await page.locator('.route-token').first().click();
    await page.getByRole('menuitem', { name: 'Choose SID…', exact: true }).click();
    await page.getByRole('button', { name: 'SPTNS1 · SPTNS1', exact: true }).click();
    const sid = page.getByRole('dialog', { name: 'Choose runway and exit', exact: true });
    await expect(sid.getByRole('button', { name: 'Add to route' })).toBeDisabled();
    await sid.getByRole('radio', { name: 'Runway 30L', exact: true }).check();
    await sid.getByRole('radio', { name: 'VLREE', exact: true }).check();
    await sid.getByText('Published restrictions', { exact: true }).click();
    await expect(sid).toContainText('STCLR: ≥ 900 ft · ≤ 230 kt');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('zlayer-plugin:routes:draft')!).entries[0].departure)).toBeUndefined();
    await showPath(page, 'STCLR', [-121.9, 37.3]);
    await page.screenshot({ path: info.outputPath('coded-sid-preview.png') });
    await sid.getByRole('button', { name: 'Add to route' }).click();
    await expect(page.getByRole('button', { name: 'Change SID for KSJC: SPTNS1', exact: true })).toBeVisible();
    await page.locator('.route-token').last().click();
    await page.getByRole('menuitem', { name: 'Choose STAR…', exact: true }).click();
    await page.getByRole('button', { name: 'OHSEA3 · OHSEA3', exact: true }).click();
    const star = page.getByRole('dialog', { name: 'Choose runway and entry', exact: true });
    await star.getByRole('radio', { name: 'Runway 20R', exact: true }).check();
    await star.getByRole('radio', { name: 'ELLBC', exact: true }).check();
    await expect(star).toContainText('no fixed endpoint');
    await showPath(page, 'OHSEA', [-117.7, 33.9]);
    await page.screenshot({ path: info.outputPath('coded-star-preview.png') });
    await star.getByRole('button', { name: 'Add to route' }).click();
    await expect(page.getByRole('button', { name: 'Change STAR for KSNA: OHSEA3', exact: true })).toBeVisible();
    await page.reload();
    await expect(page.locator('.route-token strong')).toHaveText(['KSJC', 'KSNA']);
    await expect(page.getByRole('button', { name: 'Change SID for KSJC: SPTNS1', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Change STAR for KSNA: OHSEA3', exact: true }).click();
    await page.getByRole('button', { name: 'Change runway / transition', exact: true }).click();
    await expect(star.getByRole('radio', { name: 'Runway 20R', exact: true })).toBeChecked();
    await expect(star.getByRole('radio', { name: 'ELLBC', exact: true })).toBeChecked();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Remove OHSEA3 STAR from KSNA', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Change STAR for KSNA: OHSEA3', exact: true })).toHaveCount(0);
    await expect(page.locator('.route-token strong')).toHaveText(['KSJC', 'KSNA']);
  });
});

test('a coded approach remains selectable when the chart catalog cannot be loaded', async ({ page }) => {
  await page.route('**/route-approaches.json', route => route.fulfill({ status: 503 }));
  await page.route('**/route-approach-legs.json', route => route.fulfill({ json: approaches }));
  await page.goto('/test/browser/routes.html?map');
  await page.locator('.route-token').first().click();
  await page.getByRole('menuitem', { name: 'Choose approach…', exact: true }).click();
  await page.getByRole('button', { name: 'ILS RWY 28R · I28R', exact: true }).click();
  await page.getByRole('radio', { name: 'ARCHI', exact: true }).check();
  await expect(page.getByRole('button', { name: 'View plate', exact: true })).toHaveCount(0);
  await showPath(page, 'AXMUL', [-122.25, 37.58]);
  await page.getByRole('button', { name: 'Add to route', exact: true }).click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('zlayer-plugin:routes:draft')!).entries[0].approach.source)).toBe('cifp');
  await page.reload();
  await showPath(page, 'AXMUL', [-122.25, 37.58]);
  await page.locator('.route-attached-approach').click();
  await page.getByRole('button', { name: 'Change entry', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'ARCHI', exact: true })).toBeChecked();
});
