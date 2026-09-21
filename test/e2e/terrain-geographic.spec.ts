import { test, expect } from '@playwright/test';

test('4.9-arc-second terrain survives a cold offline reload and close-up display zooms', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'Service-worker offline regression');
  await page.goto('/');
  await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
  const start = await page.evaluate(async () => {
    const path = '/assets/terrain-storage-test.js';
    return (await import(/* @vite-ignore */ path) as typeof import('../browser/terrain-storage')).save(true);
  });
  expect(start?.state, start?.error).toBe('complete');
  expect(start?.completedFiles).toBe(20);
  await context.setOffline(true);
  await page.reload();
  const requests: string[] = [];
  page.on('request', request => { if (/\.(dem|terrain)(\?|$)|\/terrain\/.*\.png|invalid\.test/.test(request.url())) requests.push(request.url()); });
  const result = await page.evaluate(async () => {
    const path = '/assets/terrain-storage-test.js';
    const api = await import(/* @vite-ignore */ path) as typeof import('../browser/terrain-storage');
    const state = await api.check(true), values = [];
    for (const z of [1, 5, 9, 10, 11, 12, 13]) values.push(await api.probe(z, true));
    return { state, values };
  });
  expect(result.state?.state).toBe('complete');
  for (const values of result.values) expect(values[0]).toBe(Math.fround(321 / 0.3048));
  expect(requests).toEqual([]);
});
