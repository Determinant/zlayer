import { expect, test } from '@playwright/test';
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import catalog from '../fixtures/route-approaches.json' with { type: 'json' };
import { refinementTerminal } from '../fixtures/route-approach-refinement';

for (const width of [320, 1280]) for (const [id, title, entry] of [
  ['KAWO:L34', 'LOC RWY 34', 'AW'], ['KGLH:I18L', 'ILS OR LOC RWY 18L', 'GLH'],
  ['KDEN:I16L', 'ILS OR LOC RWY 16L', 'Vectors to final (VTF)'],
  ['PABT:S02', 'VOR RWY 2', 'JEVUM'],
  ['KSBD:I06', 'ILS OR LOC Z RWY 06', 'PDZ'],
  ['KDEN:I34L', 'ILS RWY 34L (SA CAT I)', 'BOSSS'],
  ['KJRA:R210', 'COPTER RNAV (GPS) 210', 'FEMDU'],
  ['KSJT:S03-Y', 'VOR Y OR TACAN Y RWY 03', 'FELUV'],
]) test(`${id} retains final and missed hold through preview, save and reload at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  const terminal = refinementTerminal(id!), p = terminal.approaches!.procedures[0]!, template = catalog.airports[0]!;
  await page.route('**/route-approaches.json', route => route.fulfill({ json: { ...catalog, airports: [
    { ...template, id: p.airport, faaId: p.airport.slice(1), icaoId: p.airport, procedures: [
      { ...template.procedures.find(p => p.id === 'ils')!, name: title },
    ] },
  ] } }));
  await page.route('**/route-approach-legs.json', route => route.fulfill({ json: terminal }));
  const faf = p.final.find(l => !l.missed && l.fix?.role === 'FAF')!.fix!.ident;
  const mapFix = p.final.find(l => !l.missed && l.fix?.role === 'MAP')!.fix!.ident;
  const checkGeometry = () => page.evaluate(async ({ faf, mapFix }) => {
    const map = (window as unknown as { approachMapAudit: MapLibreMap }).approachMapAudit;
    const source = map?.getSource('route-plan') as GeoJSONSource | undefined;
    if (!source) return false;
    const data = await source.getData();
    if (data.type !== 'FeatureCollection') return false;
    const f = data.features;
    return [faf, mapFix].every(ident => f.some(x => x.geometry.type === 'Point' && x.properties?.ident === ident)) &&
      f.some(x => x.properties?.routeKind === 'approach-hold' && x.properties?.approachPhase === 'missed');
  }, { faf, mapFix });
  await page.goto(`/test/browser/routes.html?map&refinement=${encodeURIComponent(id!)}`);
  await page.locator('.route-token').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Choose approach…', exact: true }).click();
  await page.getByRole('button', { name: title!, exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Choose entry', exact: true });
  await picker.getByRole('radio', { name: entry!, exact: true }).check();
  await expect(picker).not.toContainText('Refer to the plate.');
  await expect.poll(checkGeometry).toBe(true);
  await picker.getByRole('button', { name: 'Add to route', exact: true }).click();
  await expect.poll(checkGeometry).toBe(true);
  await page.reload();
  await expect(page.locator('.route-attached-approach')).toContainText(entry === 'Vectors to final (VTF)' ? 'VTF' : entry!);
  await expect.poll(checkGeometry).toBe(true);
  await expect(page.getByLabel(/^Route issues/)).toHaveCount(0);
  await page.evaluate(async () => {
    const map = (window as unknown as { approachMapAudit: MapLibreMap }).approachMapAudit;
    const data = await (map.getSource('route-plan') as GeoJSONSource).getData();
    if (data.type !== 'FeatureCollection') return;
    const points = data.features.flatMap(f => f.geometry.type === 'Point' ? [f.geometry.coordinates] : f.geometry.type === 'LineString' ? f.geometry.coordinates : []);
    map.fitBounds([[Math.min(...points.map(p => p[0]!)), Math.min(...points.map(p => p[1]!))],
      [Math.max(...points.map(p => p[0]!)), Math.max(...points.map(p => p[1]!))]], { padding: 50, duration: 0 });
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as { approachMapAudit: MapLibreMap }).approachMapAudit
    .queryRenderedFeatures().some(f => f.properties.routeKind === 'approach-hold'))).toBe(true);
  await page.getByLabel('Approach map', { exact: true }).screenshot({ path: testInfo.outputPath(`${p.airport}-${width}.png`) });
});

for (const width of [320, 1280]) test(`helicopter title collisions retain the plate fallback at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const terminal = refinementTerminal('KHGR:R09'), template = catalog.airports[0]!;
  const title = 'COPTER RNAV (GPS) RWY 09';
  await page.route('**/route-approaches.json', route => route.fulfill({ json: { ...catalog, airports: [
    { ...template, id: 'KHGR', faaId: 'HGR', icaoId: 'KHGR', procedures: [
      { ...template.procedures.find(p => p.id === 'ils')!, name: title },
    ] },
  ] } }));
  await page.route('**/route-approach-legs.json', route => route.fulfill({ json: terminal }));
  await page.goto('/test/browser/routes.html?map&refinement=KHGR%3AR09');
  await page.locator('.route-token').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Choose approach…', exact: true }).click();
  await page.getByRole('button', { name: title, exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Choose entry', exact: true });
  await expect(picker).toContainText('Published entry data is unavailable');
  await expect(picker.getByRole('radio')).toHaveCount(0);
  await expect(picker.getByRole('button', { name: 'Add to route', exact: true })).toHaveCount(0);
  await expect(picker.getByRole('button', { name: 'View plate', exact: true })).toBeVisible();
});

for (const width of [320, 1280]) test(`parallel-runway chart preserves the selected runway after reload at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  const terminal = refinementTerminal('KBJC'), template = catalog.airports[0]!;
  const title = 'VOR/DME RWY 30L/R';
  await page.route('**/route-approaches.json', route => route.fulfill({ json: { ...catalog, airports: [
    { ...template, id: 'KBJC', faaId: 'BJC', icaoId: 'KBJC', procedures: [
      { ...template.procedures.find(p => p.id === 'ils')!, name: title },
    ] },
  ] } }));
  await page.route('**/route-approach-legs.json', route => route.fulfill({ json: terminal }));
  await page.goto('/test/browser/routes.html?map&refinement=KBJC');
  await page.locator('.route-token').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Choose approach…', exact: true }).click();
  await page.getByRole('button', { name: title, exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Choose entry', exact: true });
  await expect(picker).toContainText('Choose a runway');
  await expect(picker.getByRole('button', { name: 'Add to route', exact: true })).toHaveCount(0);
  await picker.getByRole('radio', { name: 'Runway 30R', exact: true }).check();
  await picker.getByRole('radio', { name: 'BJC', exact: true }).check();
  await expect(picker).not.toContainText('Refer to the plate.');
  await picker.screenshot({ path: testInfo.outputPath(`runway-choice-${width}.png`) });
  await picker.getByRole('button', { name: 'Add to route', exact: true }).click();
  await page.reload();
  await expect(page.locator('.route-attached-approach')).toContainText('RWY 30R');
  await expect(page.getByLabel(/^Route issues/)).toHaveCount(0);
  await page.locator('.route-attached-approach').click();
  await page.getByRole('button', { name: 'Change entry', exact: true }).click();
  await expect(picker.getByRole('radio', { name: 'Runway 30R', exact: true })).toBeChecked();
  await expect(picker.getByRole('radio', { name: 'BJC', exact: true })).toBeChecked();
  await picker.getByRole('radio', { name: 'Runway 30L', exact: true }).check();
  await expect(picker.getByRole('button', { name: 'Replace approach', exact: true })).toBeDisabled();
});
