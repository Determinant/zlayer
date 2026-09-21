import { expect, test } from '@playwright/test';
import type { Map as MapLibreMap, GeoJSONSource } from 'maplibre-gl';

type FixAudit = { map: MapLibreMap; names: () => string[] };

test('fix density, category changes and priority visibility survive repeated selection changes', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/test/browser/fixes.html');
  await page.waitForFunction(() => (window as unknown as { fixAudit?: FixAudit }).fixAudit?.map.getLayer('fixes-icons'));
  const names = () => page.evaluate(() => [...new Set((window as unknown as { fixAudit: FixAudit }).fixAudit.names())].sort());
  const zoom = (value: number) => page.evaluate(value => (window as unknown as { fixAudit: FixAudit }).fixAudit.map.jumpTo({ zoom: value }), value);
  const source = () => page.evaluate(async () => JSON.stringify(await ((window as unknown as { fixAudit: FixAudit })
    .fixAudit.map.getSource('nav-fixes') as GeoJSONSource).getData()));
  await zoom(7);
  await expect.poll(names).toEqual(['JOIN']);
  const initial = await source();
  await page.getByRole('combobox', { name: 'Show', exact: true }).selectOption('all');
  await zoom(13);
  await expect.poll(names).toEqual(['AIRWY', 'APPRO', 'ARRIV', 'JOIN', 'OFFRT']);
  await page.getByRole('button', { name: 'Select APPRO' }).click();
  await page.getByRole('button', { name: 'Hide background fixes' }).click();
  await zoom(4);
  await expect.poll(names).toEqual(['APPRO']);
  await page.getByRole('button', { name: 'Clear selection' }).click();
  await expect.poll(names).toEqual([]);
  await page.getByRole('button', { name: 'Show background fixes' }).click();
  await zoom(13);
  await expect.poll(names).toEqual(['AIRWY', 'APPRO', 'ARRIV', 'JOIN', 'OFFRT']);
  await page.getByRole('combobox', { name: 'Show', exact: true }).selectOption('enroute');
  await page.getByRole('combobox', { name: 'Enroute', exact: true }).selectOption('high');
  await expect.poll(names).toEqual([]);
  await page.getByRole('combobox', { name: 'Enroute', exact: true }).selectOption('low');
  await expect.poll(names).toEqual(['AIRWY', 'JOIN', 'OFFRT']);
  await expect.poll(source).toBe(initial);
  await expect(page.getByRole('alert')).toHaveText('');
  expect(errors).toEqual([]);
});
