import { expect, test } from '@playwright/test';
import type { Map as MapLibreMap } from 'maplibre-gl';
import published from '../fixtures/route-approach-published.json' with { type: 'json' };

test('approach previews and attached routes share the existing map fix identity and label', async ({ page }, testInfo) => {
  await page.goto('/test/browser/routes.html?map&navigation');
  await page.locator('.route-token').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Choose approach…', exact: true }).click();
  await page.getByRole('button', { name: 'ILS OR LOC RWY 28R', exact: true }).click();
  await page.getByRole('radio', { name: 'ARCHI', exact: true }).check();
  const sharedFix = () => page.evaluate(() => {
    const map = (window as unknown as { approachMapAudit: MapLibreMap }).approachMapAudit;
    if (!map.getLayer('route-waypoints')) return;
    const point = map.queryRenderedFeatures({ layers: ['route-waypoints'] }).find(feature => feature.properties.ident === 'AXMUL');
    return { id: point?.properties.mapFeatureId, role: point?.properties.approachRole,
      artcc: point?.properties.lowArtcc, hidden: (map.getGlobalState()['zlayer-route-label-ids'] as string[]).includes('fix:AXMUL') };
  });
  await expect.poll(sharedFix).toEqual({ id: 'fix:AXMUL', role: 'FAF', artcc: 'ZOA', hidden: true });
  await page.getByRole('button', { name: 'Add to route', exact: true }).click();
  await expect.poll(sharedFix).toEqual({ id: 'fix:AXMUL', role: 'FAF', artcc: 'ZOA', hidden: true });
  await page.evaluate(() => (window as unknown as { approachMapAudit: MapLibreMap }).approachMapAudit.setZoom(11));
  await page.screenshot({ path: testInfo.outputPath('existing-approach-fix.png') });
  await page.reload();
  await expect.poll(sharedFix).toEqual({ id: 'fix:AXMUL', role: 'FAF', artcc: 'ZOA', hidden: true });
});

test('an approach fix appears once in nearby selection and keeps the existing fix details', async ({ page, context, request }, testInfo) => {
  await request.post('/__test/published-approaches');
  try {
    const procedure = published.airports.find(airport => airport.id === 'KSNS')!.procedures.find(procedure => procedure.name === 'ILS RWY 31')!;
    const coordinate = published.terminal.approaches.procedures.find(procedure => procedure.id === 'KSNS:I31')!
      .final.find(leg => leg.fix?.ident === 'FREZZ')!.fix!.coordinate;
    await context.route('**/nav/manifest.json', async route => {
      const response = await route.fetch(), data = await response.json();
      data.products.find((product: { id: string }) => product.id === 'fixes').count++;
      await route.fulfill({ response, json: data });
    });
    await context.route('**/nav/fixes.geojson*', async route => {
      const response = await route.fetch(), data = await response.json();
      data.features.push({ type: 'Feature', id: 'fix:FREZZ', geometry: { type: 'Point', coordinates: coordinate },
        properties: { kind: 'fix', ident: 'FREZZ', name: 'FREZZ', lowArtcc: 'ZOA', state: 'CA' } });
      await route.fulfill({ response, json: data });
    });
    await page.addInitScript(({ procedure, coordinate }) => {
      localStorage.setItem('zlayers-map-preferences-v1', JSON.stringify({ version: 2, chartBase: '', ownshipEnabled: false }));
      localStorage.setItem('zlayers-map-view-v1', JSON.stringify({ version: 1, center: coordinate, zoom: 11, bearing: 0, pitch: 0 }));
      localStorage.setItem('zlayer-plugin:routes:draft', JSON.stringify({ version: 2, entries: [
        { id: 'destination', text: 'KSNS', approach: { airportId: 'KSNS', procedureId: procedure.id,
          name: procedure.name, cycle: '2609', entry: { routeId: 'KSNS:I31', transitionId: 'transition-fix:SNS2:1',
            name: 'ARTYY', effectiveDate: '2026-09-03' } } },
      ] }));
    }, { procedure, coordinate });
    await page.goto('/');
    await expect(page.locator('.route-attached-approach')).toHaveText('ILS 31 · ARTYY');
    const canvas = page.locator('.maplibregl-canvas'), box = (await canvas.boundingBox())!;
    const nearby = page.getByRole('dialog', { name: 'Nearby map features' });
    await expect(async () => {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
      await expect(nearby).toBeVisible();
    }).toPass();
    const choices = nearby.getByRole('button', { name: /FREZZ/ });
    await expect(choices).toHaveCount(1);
    await choices.click();
    const card = page.locator('.feature-card');
    await expect(card).toContainText('ZOA');
    await expect(card).toContainText('Coordinates');
    await expect(page.getByRole('button', { name: 'Remove approach from KSNS', exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('zlayer-ui:selected-feature')!).value.id)).toBe('fix:FREZZ');
    await page.screenshot({ path: testInfo.outputPath('existing-fix-details.png') });
  } finally { await request.post('/__test/reset'); }
});
