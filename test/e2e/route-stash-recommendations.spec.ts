import { test, expect } from '@playwright/test';
import type { Map as MapLibreMap } from 'maplibre-gl';

const stashKey = 'zlayer-plugin:routes:stash', draftKey = 'zlayer-plugin:routes:draft';
const approach = { kind: 'approach', source: 'chart', airportId: 'KSFO', procedureId: 'ils', name: 'ILS OR LOC RWY 28R', cycle: '2609',
  entry: { routeId: 'KSFO:I28R', transitionId: 'transition:ARCHI', name: 'ARCHI', effectiveDate: '2026-09-03' } };
const savedEntries = [
  { id: 'sjc', text: 'SJC', pinnedFeatureId: 'KSJC' },
  { id: 'vfr', text: 'VPWAM', pinnedFeatureId: 'vfr-waypoints:VPWAM' },
  { id: 'gps', text: '374529N1223030W' },
  { id: 'sfo', text: 'SFO', pinnedFeatureId: 'KSFO', approach },
];

test('Advise previews matching stash routes and restores their full saved draft', async ({ page }, testInfo) => {
  await page.addInitScript(({ stashKey, draftKey, savedEntries }) => {
    localStorage.setItem(draftKey, JSON.stringify({ version: 2, entries: [
      { id: 'from', text: 'KSJC' }, { id: 'to', text: 'KSFO' },
    ] }));
    localStorage.setItem(stashKey, JSON.stringify({ version: 1, routes: [
      { id: 'coast', name: 'Coastal arrival', draft: { entries: savedEntries } },
      { id: 'direct', name: '', draft: { entries: [{ id: 'from', text: 'KSJC' }, { id: 'to', text: 'KSFO' }] } },
      { id: 'reverse', name: 'Return flight', draft: { entries: [...savedEntries].reverse() } },
      { id: 'elsewhere', name: 'Other destination', draft: { entries: [{ id: 'from', text: 'KSJC' }, { id: 'to', text: 'KNUQ' }] } },
    ] }));
  }, { stashKey, draftKey, savedEntries });
  await page.goto('/test/browser/routes.html?entities&map');
  const original = await page.evaluate(key => localStorage.getItem(key), draftKey);
  const saved = await page.evaluate(key => localStorage.getItem(key), stashKey);
  await page.getByRole('button', { name: 'Advise', exact: true }).click();
  const section = page.getByRole('region', { name: /^Route Stash/ });
  await expect(section.getByRole('listitem')).toHaveCount(2);
  await expect(section.locator('.route-suggestion-meta').first()).toContainText('Coastal arrival');
  await expect(section.locator('.route-suggestion-meta').last()).toContainText('Saved route');
  await expect(section.getByText('Partial map')).toHaveCount(0);
  await expect(section.getByText('No map · unresolved')).toHaveCount(0);
  const preview = section.getByRole('button', { name: /^Preview route Coastal arrival:/ });
  await preview.click();
  await expect(preview).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => {
    const map = (window as unknown as { approachMapAudit: MapLibreMap }).approachMapAudit;
    if (!map?.getSource('route-plan')) return false;
    const features = map.querySourceFeatures('route-plan');
    return features.some(feature => feature.properties.ident === 'VPWAM') &&
      features.some(feature => feature.properties.approachPoint);
  })).toBe(true);
  expect(await page.evaluate(key => localStorage.getItem(key), draftKey)).toBe(original);
  await page.screenshot({ path: testInfo.outputPath('stash-recommendations.png') });
  await page.setViewportSize({ width: 320, height: 568 });
  await preview.scrollIntoViewIfNeeded();
  expect(await section.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('stash-recommendations-phone.png') });
  await section.getByRole('button', { name: /^Use route Coastal arrival:/ }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).entries, draftKey)).toEqual(savedEntries);
  expect(await page.evaluate(key => localStorage.getItem(key), stashKey)).toBe(saved);
  await expect(page.locator('.route-token')).toHaveCount(4);
});

test('stash recommendations refresh across tabs and recover storage errors independently of published routes', async ({ page, context }) => {
  await page.addInitScript(({ draftKey }) => {
    localStorage.setItem(draftKey, JSON.stringify({ version: 2, entries: [
      { id: 'from', text: 'KSBA' }, { id: 'to', text: 'KSMO' },
    ] }));
  }, { draftKey });
  await page.goto('/');
  await page.getByRole('button', { name: 'Advise', exact: true }).click();
  const section = page.getByRole('region', { name: /^Route Stash/ });
  await expect(section).toContainText('No saved routes for this departure and destination.');
  const other = await context.newPage();
  await other.goto('/test/browser/routes.html');
  await other.evaluate(({ stashKey }) => {
    localStorage.setItem(stashKey, JSON.stringify({ version: 1, routes: [{ id: 'shared', name: 'From another tab', draft: { entries: [
      { id: 'from', text: 'SBA' }, { id: 'to', text: 'SMO' },
    ] } }] }));
  }, { stashKey });
  await expect(section.getByRole('listitem')).toHaveCount(1);
  await expect(section).toContainText('From another tab');
  await other.evaluate(key => localStorage.setItem(key, '{broken'), stashKey);
  await expect(section.getByRole('alert')).toContainText('Saved routes could not be read');
  await expect(page.locator('[data-route-category="preferred"] .route-suggestion-use').first()).toBeEnabled();
  await expect(page.locator('[data-route-category="frequency"] .route-suggestion-use').first()).toBeEnabled();
  expect(await page.evaluate(key => localStorage.getItem(key), stashKey)).toBe('{broken');
  await page.bringToFront();
  await expect(section.getByRole('alert')).toBeVisible();
  // No storage event fires in the writer's own window; the section's Retry must re-read it.
  await page.evaluate(key => localStorage.setItem(key, JSON.stringify({ version: 1, routes: [] })), stashKey);
  await section.getByRole('button', { name: 'Retry Route Stash' }).click();
  await expect(section.getByRole('alert')).toHaveCount(0);
  await expect(section).toContainText('No saved routes for this departure and destination.');
});
