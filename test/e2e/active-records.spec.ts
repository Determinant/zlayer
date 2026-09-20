import { test, expect, type Page } from '@playwright/test';

const keys = (page: Page, prefix: string) => page.evaluate(prefix => window.lifecycle.storage.keys(prefix), prefix);

test('reopening the app reclaims closed-tab records while protecting another live tab', async ({ page, context }) => {
  await context.addInitScript(() => { Reflect.deleteProperty(Navigator.prototype, 'serviceWorker'); });
  await page.goto('/test/e2e/lifecycle.html');
  await page.evaluate(async () => {
    await window.lifecycle.storage.write('test-record:keep', { saved: true });
    window.lifecycle.retainFiles(['https://charts.test/background.pdf']);
  });
  await expect.poll(() => keys(page, 'active-files:')).toHaveLength(1);
  const live = await keys(page, 'active-files:');

  const closedViewer = await context.newPage();
  await closedViewer.goto('/test/e2e/lifecycle.html');
  await closedViewer.evaluate(() => { window.lifecycle.retainFiles(['https://charts.test/closed.pdf']); });
  await expect.poll(() => keys(page, 'active-files:')).toHaveLength(2);
  const orphan = (await keys(page, 'active-files:')).find(key => !live.includes(key))!;
  await closedViewer.close();
  await expect.poll(() => page.evaluate(async key => (await navigator.locks.query()).held?.some(lock => lock.name === key), orphan)).toBe(false);
  expect(await keys(page, 'active-files:')).toContain(orphan);

  for (let i = 0; i < 3; i++) {
    const app = await context.newPage();
    await app.goto('/');
    await expect(app.getByLabel('Search FAA navigation data')).toBeVisible();
    await expect.poll(() => page.evaluate(async () => {
      const held = (await navigator.locks.query()).held?.filter(lock => lock.name?.startsWith('active-catalog:')).map(lock => lock.name);
      const records = await window.lifecycle.storage.keys('active-catalog:');
      return held?.length === 1 && records.length === 1 && held[0] === records[0];
    })).toBe(true);
    await expect.poll(() => keys(page, 'active-files:')).toEqual(live);
    await app.close();
    await expect.poll(() => page.evaluate(async () => (await navigator.locks.query()).held?.filter(lock => lock.name?.startsWith('active-catalog:')))).toEqual([]);
  }
  // Cleanup also works without network access; no timestamp expires the background owner.
  await context.setOffline(true);
  await page.evaluate(() => window.lifecycle.pruneInactiveRecords());
  expect(await keys(page, 'active-catalog:')).toEqual([]);
  expect(await keys(page, 'active-files:')).toEqual(live);
  expect(await page.evaluate(() => window.lifecycle.storage.read('test-record:keep'))).toEqual({ saved: true });
});
