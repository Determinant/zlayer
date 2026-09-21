import { expect, test } from '@playwright/test';
import type { Map as MapLibreMap } from 'maplibre-gl';
import catalog from '../fixtures/route-approaches.json' with { type: 'json' };
import { arizonaTerminal } from '../fixtures/route-approach-arizona';

test.use({ hasTouch: true });

for (const width of [320, 1280]) for (const missing of [false, true]) {
  test(`KIWA ${missing ? 'gap preserves hold and warning' : 'return connects to hold'} in preview and reload at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const template = catalog.airports[0]!;
    await page.route('**/route-approaches.json', route => route.fulfill({ json: { ...catalog, airports: [
      { ...template, id: 'KIWA', faaId: 'IWA', icaoId: 'KIWA', procedures: [
        { ...template.procedures.find(p => p.id === 'ils')!, name: 'ILS OR LOC RWY 30C' },
      ] },
    ] } }));
    await page.route('**/route-approach-legs.json', route => route.fulfill({ json: arizonaTerminal(missing) }));
    const rendered = () => page.evaluate(() => {
      const map = (window as unknown as { approachMapAudit: MapLibreMap }).approachMapAudit;
      const features = map.queryRenderedFeatures();
      return {
        fix: features.some(f => f.geometry.type === 'Point' && f.properties.ident === 'IWA'),
        hold: features.some(f => f.properties.routeKind === 'approach-hold' && f.properties.approachPhase === 'missed'),
        connection: features.some(f => f.properties.routeKind === 'approach-missed'),
      };
    });
    await page.goto(`/test/browser/routes.html?map&arizona${missing ? '&missing-intercept' : ''}`);
    await page.locator('.route-token').first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Choose approach…', exact: true }).click();
    await page.getByRole('button', { name: 'ILS OR LOC RWY 30C', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Choose entry', exact: true });
    await picker.getByRole('radio', { name: 'Vectors to final (VTF)', exact: true }).check();
    if (missing) await expect(picker).toContainText('The intercept heading or following inbound course is unavailable.');
    else await expect(picker).not.toContainText('Refer to the plate.');
    await expect.poll(rendered).toEqual({ fix: true, hold: true, connection: !missing });
    await picker.getByRole('button', { name: 'Add to route', exact: true }).click();
    await expect.poll(rendered).toEqual({ fix: true, hold: true, connection: !missing });
    await expect(page.getByLabel(/^Route issues \(1\): KIWA:/)).toHaveCount(missing ? 1 : 0);
    await page.reload();
    await expect(page.locator('.route-attached-approach')).toHaveText('ILS OR LOC 30C · VTF');
    await expect.poll(rendered).toEqual({ fix: true, hold: true, connection: !missing });
    await expect(page.getByLabel(/^Route issues \(1\): KIWA:/)).toHaveCount(missing ? 1 : 0);
    await page.evaluate(() => (window as unknown as { approachMapAudit: MapLibreMap }).approachMapAudit
      .jumpTo({ center: [-111.65, 33.30], zoom: 12 }));
    await expect.poll(rendered).toEqual({ fix: true, hold: true, connection: !missing });
    await page.getByLabel('Approach map', { exact: true }).screenshot({ path: testInfo.outputPath(`kiwa-${missing ? 'gap' : 'connected'}-${width}.png`) });
  });
}
