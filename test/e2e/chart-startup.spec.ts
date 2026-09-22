import { test, expect } from '@playwright/test';

type StartupGate = { allow: boolean; failures: number };

test('selected charts keep startup covered until their first render', async ({ page, request }) => {
  await request.post('/__test/hold-chart-archives');
  await page.addInitScript(() => localStorage.setItem('zlayers-map-preferences-v1', JSON.stringify({
    chartBase: 'vfr-sectional', ownshipEnabled: false, metarEnabled: false, terrainEnabled: false, obstructionsEnabled: false,
  })));
  try {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const splash = page.getByRole('dialog', { name: 'ZLayer', exact: true });
    const charts = splash.getByRole('listitem').filter({ has: page.getByText('Charts', { exact: true }) });
    await expect(page.getByLabel('Chart status', { exact: true })).toContainText('MBTILES');
    await expect(charts).toContainText('Rendering…');
    await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'true');
    // A ready chart cache is insufficient while the visible chart is still loading.
    await page.waitForTimeout(1200);
    await expect(splash).toBeVisible();
    await request.post('/__test/allow-chart-archives');
    await expect(splash).toHaveCount(0);
    await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false');
  } finally { await request.post('/__test/allow-chart-archives'); }
});

for (const failure of ['registration', 'preparation', 'preparation timeout'] as const) {
  test(`sectionals recover from failed worker ${failure} on the first page`, async ({ page }) => {
    const errors: string[] = [], archives: string[] = [];
    let navigations = 0;
    page.on('pageerror', error => errors.push(error.message));
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
    page.on('request', request => { if (new URL(request.url()).pathname.endsWith('.mbtiles')) archives.push(request.url()); });
    await page.addInitScript(failure => {
      const state: StartupGate = { allow: false, failures: 0 };
      Object.assign(window, { chartStartupGate: state });
      if (failure === 'registration') {
        const register = navigator.serviceWorker.register.bind(navigator.serviceWorker);
        navigator.serviceWorker.register = (...args) => {
          if (state.allow) return register(...args);
          state.failures++;
          return Promise.reject(new TypeError('Temporary registration failure'));
        };
      } else {
        const postMessage = ServiceWorker.prototype.postMessage;
        ServiceWorker.prototype.postMessage = function (message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) {
          if (!state.allow && (message as { type?: string })?.type === 'prepare-pwa') {
            state.failures++;
            const ports = Array.isArray(transfer) ? transfer : transfer?.transfer;
            if (failure !== 'preparation timeout') {
              (ports?.[0] as MessagePort).postMessage({ error: 'Temporary storage preparation failure' });
            }
            return;
          }
          postMessage.call(this, message, transfer as StructuredSerializeOptions);
        };
      }
    }, failure);
    await page.goto('/');
    const status = page.getByLabel('Chart status', { exact: true });
    await expect(status).toContainText('Preparing whole-file chart cache', { timeout: 20_000 });
    expect(archives).toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { chartStartupGate: StartupGate }).chartStartupGate.failures)).toBeGreaterThan(0);
    await page.evaluate(() => { (window as unknown as { chartStartupGate: StartupGate }).chartStartupGate.allow = true; });

    await expect(status).toContainText('MBTILES', { timeout: 20_000 });
    await expect.poll(() => archives.length).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(async () => {
      const cache = await caches.open('zlayers-chart-archives-v3');
      return (await cache.keys()).length;
    })).toBeGreaterThan(0);
    await expect(page.getByRole('button', { name: 'Retry chart cache' })).toHaveCount(0);
    expect(navigations).toBe(1);
    expect(errors).toEqual([]);
  });
}
