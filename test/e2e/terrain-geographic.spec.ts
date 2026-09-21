import { test, expect } from '@playwright/test';

for (const [fixture, spacing, files, height] of [[true, 4.9, 20, 321], ['fine', 2.45, 22, 654]] as const)
test(`${spacing}-arc-second terrain survives a cold offline reload and close-up display zooms`, async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'Service-worker offline regression');
  await page.goto('/');
  await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
  const start = await page.evaluate(async fixture => {
    const path = '/assets/terrain-storage-test.js';
    return (await import(/* @vite-ignore */ path) as typeof import('../browser/terrain-storage')).save(fixture);
  }, fixture);
  expect(start?.state, start?.error).toBe('complete');
  expect(start?.completedFiles).toBe(files);
  await context.setOffline(true);
  await page.reload();
  const requests: string[] = [];
  page.on('request', request => { if (/\.(dem|terrain)(\?|$)|\/terrain\/.*\.png|invalid\.test/.test(request.url())) requests.push(request.url()); });
  const result = await page.evaluate(async fixture => {
    const path = '/assets/terrain-storage-test.js';
    const api = await import(/* @vite-ignore */ path) as typeof import('../browser/terrain-storage');
    const state = await api.check(fixture), values = [];
    for (const z of [1, 5, 9, 10, 11, 12, 13]) values.push(await api.probe(z, fixture));
    return { state, values };
  }, fixture);
  expect(result.state?.state).toBe('complete');
  for (const values of result.values) expect(values[0]).toBe(Math.fround(height / 0.3048));
  expect(requests).toEqual([]);
});
