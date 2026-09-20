import { test, expect } from '@playwright/test';

test('error recovery remounts failed content and preserves healthy panel state', async ({ page }) => {
  await page.goto('/test/e2e/lifecycle.html');
  const input = page.getByLabel('Panel state');
  await input.fill('kept');
  await page.evaluate(() => window.lifecycle.retryPanel());
  await expect(input).toHaveValue('kept');
  await page.evaluate(() => window.lifecycle.failPanel(true));
  await expect(page.getByRole('alert')).toHaveText('Test panel failure');
  await page.evaluate(() => window.lifecycle.failPanel(false));
  await expect(page.getByRole('alert')).toHaveText('Test panel failure');
  await page.evaluate(() => window.lifecycle.retryPanel());
  await expect(input).toHaveValue('initial');
  await input.fill('recovered');
  await page.evaluate(() => window.lifecycle.retryPanel());
  await expect(input).toHaveValue('recovered');
});

test('focus preserves inventory while downloads in another tab still notify readers', async ({ page, context }) => {
  await page.goto('/test/e2e/lifecycle.html');
  await expect.poll(() => page.evaluate(() => window.lifecycle.stats().subscribers)).toBe(1);
  const before = await page.evaluate(() => window.lifecycle.stats());
  await page.evaluate(async () => {
    for (let i = 0; i < 3; i++) {
      window.dispatchEvent(new Event('focus'));
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    }
  });
  await expect(page.getByTestId('inventory')).toHaveText('0');
  expect(await page.evaluate(() => window.lifecycle.stats())).toEqual(before);

  const otherTab = await context.newPage();
  await otherTab.goto('/test/e2e/lifecycle.html');
  await expect.poll(() => otherTab.evaluate(() => window.lifecycle.stats().subscribers)).toBe(1);
  await otherTab.evaluate(() => window.lifecycle.inventoryChanged());
  await expect.poll(async () => Number(await page.getByTestId('inventory').textContent())).toBeGreaterThan(0);
  await expect.poll(async () => Number(await otherTab.getByTestId('inventory').textContent())).toBeGreaterThan(0);
  await otherTab.close();
});

test('React observes layer, connectivity and inventory changes and releases subscriptions on unmount', async ({ page, context }) => {
  await page.goto('/test/e2e/lifecycle.html');
  await expect(page.getByTestId('count')).toHaveText('0');
  await expect.poll(() => page.evaluate(() => window.lifecycle.stats().subscribers)).toBe(1);
  await page.evaluate(() => window.lifecycle.publish(7));
  await expect(page.getByTestId('count')).toHaveText('7');
  await context.setOffline(true);
  await expect(page.getByTestId('online')).toHaveText('false');
  await context.setOffline(false);
  await expect(page.getByTestId('online')).toHaveText('true');
  const inventory = Number(await page.getByTestId('inventory').textContent());
  await page.evaluate(() => window.lifecycle.inventoryChanged());
  // A local DOM notification and its BroadcastChannel copy may both arrive.
  await expect.poll(async () => Number(await page.getByTestId('inventory').textContent())).toBeGreaterThan(inventory);
  const stopped = await page.evaluate(() => { window.lifecycle.unmount(); return window.lifecycle.stats(); });
  expect(stopped.subscribers).toBe(0);
  await page.evaluate(() => { window.lifecycle.publish(9); window.lifecycle.inventoryChanged(); });
  expect(await page.evaluate(() => window.lifecycle.stats())).toEqual(stopped);
  await page.evaluate(() => window.lifecycle.mount());
  await expect(page.getByTestId('count')).toHaveText('9');
  await expect.poll(() => page.evaluate(() => window.lifecycle.stats().subscribers)).toBe(1);
});

test('late route exports cannot replace a newer national resolver in a mounted React tree', async ({ page }) => {
  let finishOld!: () => void;
  const oldGate = new Promise<void>(resolve => { finishOld = resolve; });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/lifecycle/*.json', async route => {
    const old = route.request().url().endsWith('/old.json');
    if (old) await oldGate;
    const ident = old ? 'OLD' : 'NEW';
    await route.fulfill({ json: { type: 'FeatureCollection', metadata: { effectiveDate: '2026-09-03', source: 'FAA' },
      features: [{ type: 'Feature', id: ident, geometry: { type: 'Point', coordinates: [0, 0] }, properties: { ident } }] } });
  });
  await page.goto('/test/e2e/lifecycle.html');
  await expect(page.getByTestId('count')).toHaveText('0');
  const oldStarted = page.waitForRequest('**/lifecycle/old.json');
  await page.evaluate(() => window.lifecycle.routeExport('old'));
  await oldStarted;
  await page.evaluate(() => window.lifecycle.routeExport('new'));
  await expect(page.getByTestId('route')).toHaveAttribute('data-status', 'ready');
  await expect(page.getByTestId('route')).toHaveText('NEW');
  const oldFinished = page.waitForResponse('**/lifecycle/old.json');
  finishOld();
  await (await oldFinished).finished();
  await expect(page.getByTestId('route')).toHaveText('NEW');
  await page.evaluate(() => window.lifecycle.unmount());
  expect(errors).toEqual([]);
});
