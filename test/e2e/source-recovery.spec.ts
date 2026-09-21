import { test, expect, type Page, type Route } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  // These cases disable service workers to intercept individual source requests.
  // Chart archives require worker control; keep that separate from UI recovery.
  await page.addInitScript(() => localStorage.setItem('zlayers-map-preferences-v1',
    JSON.stringify({ chartBase: '', ownshipEnabled: false })));
});

async function openApproach(page: Page) {
  await page.getByLabel('Search FAA navigation data').fill('KSBA');
  await page.locator('.search-results button').filter({ hasText: 'KSBA' }).click();
  await page.getByRole('button', { name: 'Plates', exact: true }).click();
  await page.getByRole('button', { name: /TEST APPROACH/ }).click();
}

test('airport search stays usable while another navigation feed is pending', async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(() => { Reflect.deleteProperty(Navigator.prototype, 'serviceWorker'); });
  let hold!: (route: Route) => void;
  const pending = new Promise<Route>(resolve => { hold = resolve; });
  await page.route('**/nav/fixes.geojson*', hold);
  await page.goto('/');
  await expect(page.getByLabel('Search FAA navigation data')).toBeAttached();
  // The startup escape appears after ten seconds of unfinished map data.
  await page.clock.fastForward(10_001);
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
  await page.getByLabel('Search FAA navigation data').fill('KSBA');
  const held = await pending;
  try {
    const airport = page.locator('.search-results button').filter({ hasText: 'KSBA' });
    await expect(airport).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Loading more results…' })).toBeVisible();
    await airport.click();
    await expect(page.getByRole('button', { name: 'Plates', exact: true })).toBeVisible();
    await expect(page.locator('.search-results')).toHaveCount(0);
  } finally { await held.continue(); }
  await expect(page.locator('.search-results')).toHaveCount(0);
});

for (const renderer of ['canvas', 'viewer'] as const) {
  test(`${renderer} offers working recovery after a failed module download`, async ({ page }) => {
    await page.addInitScript(() => { Reflect.deleteProperty(Navigator.prototype, 'serviceWorker'); });
    let blocked = true;
    const intercept = () => page.route(`**/assets/${renderer}-*.js`, route => blocked ? route.abort('failed') : route.continue());
    if (renderer === 'canvas') await intercept();
    await page.goto('/');
    if (renderer === 'viewer') {
      // The shared viewer-dialog chunk belongs to startup; fail only the lazy renderer.
      await expect(page.getByLabel('Settings and offline downloads')).toBeVisible();
      await intercept();
      await openApproach(page);
    }
    const failure = page.getByRole('alert').filter({ hasText: 'Failed to fetch dynamically imported module' });
    await expect(failure).toBeVisible();
    blocked = false;
    if (renderer === 'viewer') {
      // A fresh React.lazy instance still sees the browser's failed module entry.
      await failure.getByRole('button', { name: 'Retry', exact: true }).click();
      await expect(failure).toBeVisible();
    }
    await failure.getByRole('button', { name: 'Reload app', exact: true }).click();
    if (renderer === 'viewer') {
      // Reload restores the selected plate and its modal automatically.
      await expect(page.getByText('Available offline', { exact: true })).toBeVisible();
      await expect(page.locator('.procedure-page-loading')).toHaveCount(0);
    } else await expect(page.getByRole('region', { name: 'Map', exact: true })).toBeVisible();
    await expect(failure).toHaveCount(0);
  });
}

test('settings opens without further code downloads and keeps state on reopening', async ({ page }) => {
  // Exercise online fallback when the browser cannot precache a complete shell.
  await page.addInitScript(() => { Reflect.deleteProperty(Navigator.prototype, 'serviceWorker'); });
  await page.goto('/');
  const launcher = page.getByLabel('Settings and offline downloads');
  await expect(launcher).toBeEnabled();
  await page.route('**/assets/*.js', route => route.abort('failed'));
  await launcher.click();
  const search = page.getByLabel('Find a state or territory');
  await expect(search).toBeVisible();
  await search.fill('California');
  await page.getByLabel('Close settings').click();
  await launcher.click();
  await expect(search).toHaveValue('California');
});

for (const delayed of ['procedures', 'supplements'] as const) {
  test(`available airport plates remain usable while ${delayed} metadata is pending`, async ({ page }) => {
    await page.addInitScript(() => { Reflect.deleteProperty(Navigator.prototype, 'serviceWorker'); });
    let hold!: (route: Route) => void;
    const pending = new Promise<Route>(resolve => { hold = resolve; });
    const path = delayed === 'procedures' ? '**/tpp/catalog.json*' : '**/cs/catalog.json*';
    await page.route(path, hold);
    await page.goto('/');
    await page.getByLabel('Search FAA navigation data').fill('KSBA');
    await page.locator('.search-results button').filter({ hasText: 'KSBA' }).click();
    await page.getByRole('button', { name: 'Plates', exact: true }).click();
    const held = await pending;
    try {
      const available = page.getByRole('button', { name: delayed === 'procedures' ? /Chart Supplement/ : /TEST APPROACH/ });
      await expect(available).toBeVisible();
      await expect(page.getByText(delayed === 'procedures' ? 'Loading procedures…' : 'Loading Chart Supplement…', { exact: true })).toBeVisible();
      await available.click();
      await expect(page.getByText('Available offline', { exact: true })).toBeVisible();
      await expect(page.locator('.procedure-page-loading')).toHaveCount(0);
      await page.getByLabel('Close plate').click();
    } finally { await held.continue(); }
    await page.getByRole('button', { name: 'Show KSBA details', exact: true }).click();
    await expect(page.getByRole('button', { name: /TEST APPROACH/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Chart Supplement/ })).toBeVisible();
  });
}
