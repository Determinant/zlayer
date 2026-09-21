import { test, expect } from '@playwright/test';

test('a complete terrain region survives a cold offline reload at every native zoom and detects eviction', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'Playwright supports service-worker testing on Chromium only: https://playwright.dev/docs/service-workers');
  await page.goto('/');
  await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated');
  const start = await page.evaluate(async () => {
    const path = '/assets/terrain-storage-test.js';
    return (await import(/* @vite-ignore */ path) as typeof import('../browser/terrain-storage')).save();
  });
  expect(start?.state, start?.error).toBe('complete');
  expect(start?.completedFiles).toBe(26);
  const network: string[] = [];
  page.on('request', request => { if (/\.(dem|terrain)(\?|$)/.test(request.url())) network.push(request.url()); });
  await context.setOffline(true);
  await page.reload();
  const result = await page.evaluate(async () => {
    const path = '/assets/terrain-storage-test.js';
    const api = await import(/* @vite-ignore */ path) as typeof import('../browser/terrain-storage');
    const state = await api.check();
    const values = [];
    for (let zoom = 1; zoom <= 13; zoom++) values.push(await api.probe(zoom));
    return { state, values };
  });
  expect(result.state?.state).toBe('complete');
  for (const values of result.values) {
    expect(values[0]).toBe(Math.fround(123.5 / 0.3048));
    expect(values[1]).toBe(Math.fround(-0.25 / 0.3048));
    expect(Number.isNaN(values[2])).toBe(true);
    expect(values[3]).toBe(0);
  }
  expect(network).toEqual([]);
  const afterEviction = await page.evaluate(async () => {
    const path = '/assets/terrain-storage-test.js';
    const api = await import(/* @vite-ignore */ path) as typeof import('../browser/terrain-storage');
    const job = (await api.check())!;
    const file = job.files.slice().reverse().find(file => new URL(file.url).pathname.endsWith('.dem'))!;
    await (await caches.open('zlayers-chart-archives-v3')).delete(file.url);
    return api.check();
  });
  expect(afterEviction?.state).toBe('paused');
  await context.setOffline(false);
  const repaired = await page.evaluate(async () => {
    const path = '/assets/terrain-storage-test.js';
    return (await import(/* @vite-ignore */ path) as typeof import('../browser/terrain-storage')).save();
  });
  expect(repaired?.state, repaired?.error).toBe('complete');
});
