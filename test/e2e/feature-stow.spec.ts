import { expect, test, type Page } from '@playwright/test';
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';

async function selectAirport(page: Page, ident: string) {
  await page.getByLabel('Search FAA navigation data').fill(ident);
  await page.locator('.search-results button').filter({ hasText: ident }).click();
}

test.describe('airport details on touch screens', () => {
  test.use({ hasTouch: true });
  for (const [width, height] of [[320, 568], [393, 852], [568, 320]] as const) {
    test(`stowing preserves Info, Plates, and ID at ${width}×${height}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height });
      await page.goto('/');
      await selectAirport(page, 'KSBA');
      const card = page.locator('.feature-card');
      const body = page.locator('.feature-card-content');
      const originalCard = await card.elementHandle();
      for (const mode of ['Info', 'Plates', 'ID']) {
        if (mode === 'ID') await page.getByRole('button', { name: 'Identify KSBA with nearby navaids' }).tap();
        else await page.getByRole('tab', { name: mode, exact: true }).tap();
        if (mode === 'Plates') await expect(page.getByRole('button', { name: /TEST APPROACH/ })).toBeVisible();
        if (mode === 'ID') await expect(page.locator('.nearby-navaids')).toContainText('CMA');
        const contents = await body.textContent();
        const scroll = await body.evaluate(element => {
          element.scrollTop = element.scrollHeight;
          return element.scrollTop;
        });
        const hide = page.getByRole('button', { name: 'Hide KSBA details', exact: true });
        const target = (await hide.boundingBox())!;
        expect(target.width).toBeGreaterThanOrEqual(44);
        expect(target.height).toBeGreaterThanOrEqual(44);
        expect(target.x).toBeGreaterThanOrEqual(0);
        await hide.tap();
        const show = page.getByRole('button', { name: 'Show KSBA details', exact: true });
        await expect(show).toHaveAttribute('aria-expanded', 'false');
        await expect(card).toBeHidden();
        await expect(card).toHaveAttribute('inert', '');
        await expect.poll(async () => {
          const edge = (await show.boundingBox())!;
          return Math.round(edge.x + edge.width);
        }).toBe(width);
        await expect(page.getByRole('button', { name: 'Close detail' })).toHaveCount(0);
        await page.getByRole('button', { name: 'Zoom in', exact: true }).tap();
        await expect(show).toHaveAttribute('aria-expanded', 'false');
        if (mode === 'ID') await page.screenshot({ path: testInfo.outputPath('airport-id-stowed.png') });
        await show.tap();
        await expect(card).toBeVisible();
        await page.locator('.side-panels').evaluate(element =>
          Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)));
        const bounds = (await card.boundingBox())!;
        expect(bounds.x).toBeGreaterThanOrEqual(44);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
        expect(await card.evaluate((element, original) => element === original, originalCard)).toBe(true);
        await expect(body).toHaveText(contents!);
        expect(await body.evaluate(element => element.scrollTop)).toBe(scroll);
        if (mode === 'ID') await expect(page.getByRole('button', { name: 'Identify KSBA with nearby navaids' }))
          .toHaveAttribute('aria-pressed', 'true');
        else await expect(page.getByRole('tab', { name: mode, exact: true })).toHaveAttribute('aria-selected', 'true');
      }
      await page.screenshot({ path: testInfo.outputPath('airport-id-open.png') });
      await page.getByRole('button', { name: 'Hide KSBA details', exact: true }).tap();
      await selectAirport(page, 'KSMO');
      await expect(page.getByRole('button', { name: 'Hide KSMO details', exact: true })).toHaveAttribute('aria-expanded', 'true');
      await expect(card.locator('h2')).toHaveText('KSMO');
      await page.getByRole('button', { name: 'Close detail', exact: true }).tap();
      await expect(page.locator('.feature-details-panel')).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  }
});

test('Escape stows ID, keeps its map lines, and returns focus to the reopen handle', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await page.goto('/test/browser/identification.html');
  const identify = page.getByRole('button', { name: /Identify .* with nearby navaids/ });
  await identify.click();
  const readMap = () => page.evaluate(async () => {
    const map = (window as unknown as { identificationAudit: { map: MapLibreMap } }).identificationAudit.map;
    return (map.getSource('navaid-identification') as GeoJSONSource | undefined)?.getData();
  });
  await expect.poll(async () => {
    const data = await readMap();
    return data?.type === 'FeatureCollection' && data.features.filter(feature => feature.geometry.type === 'LineString').length;
  }).toBe(3);
  const before = await readMap();
  await identify.press('Escape');
  const show = page.getByRole('button', { name: /^Show .* details$/ });
  await expect(show).toBeFocused();
  await expect(page.locator('.feature-card')).toBeHidden();
  expect(await readMap()).toEqual(before);
  await page.screenshot({ path: testInfo.outputPath('id-lines-stowed.png') });
  await show.press('Enter');
  await expect(identify).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Close detail', exact: true }).click();
  await expect.poll(readMap).toEqual({ type: 'FeatureCollection', features: [] });
});
