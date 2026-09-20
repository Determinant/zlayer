import { test, expect } from '@playwright/test';

test('obstructions fade in the route corridor and follow route/toggle/remount changes', async ({ page }, testInfo) => {
  const errors: string[] = [], downloads: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().includes('/obstacles/')) downloads.push(request.url()); });
  await page.goto('/test/browser/obstructions.html?zoom=6.99&route=none');
  const status = page.locator('output[data-state]');
  await expect(status).toHaveAttribute('data-state', 'zoom');
  expect(downloads).toHaveLength(0);
  await page.getByRole('button', { name: 'Restore route' }).click();
  await expect(status).toHaveAttribute('data-state', 'ready');
  await expect(status).toHaveAttribute('data-count', '7');
  await expect.poll(() => page.locator('body').getAttribute('data-rendered-obstructions').then(value => JSON.parse(value ?? '[]').length)).toBe(7);
  const features = JSON.parse((await page.locator('body').getAttribute('data-published-obstructions'))!);
  expect(features.find((feature: { id: string }) => feature.id === '06-000001').properties.routeOpacity).toBe(1);
  expect(features.find((feature: { id: string }) => feature.id === '06-000007').properties.routeOpacity).toBeCloseTo(0.5, 1);
  expect(features.some((feature: { id: string }) => feature.id === '06-000008')).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('route-obstructions.png') });
  const gzipDownloads = downloads.filter(url => url.endsWith('.gz')).length;
  for (const action of ['Move route', 'Clear route']) {
    await page.getByRole('button', { name: action, exact: true }).click();
    await expect.poll(() => page.locator('body').getAttribute('data-rendered-obstructions').then(value => JSON.parse(value ?? '[]').length)).toBe(0);
    await page.getByRole('button', { name: 'Restore route' }).click();
    await expect(status).toHaveAttribute('data-state', 'ready');
    await expect(status).toHaveAttribute('data-count', '7');
  }
  const toggle = page.getByRole('switch', { name: /^Obstructions/ });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(status).toHaveAttribute('data-state', 'idle');
  await toggle.click();
  await expect(status).toHaveAttribute('data-state', 'ready');
  await page.getByRole('button', { name: 'Remount' }).click();
  await expect(status).toHaveAttribute('data-state', 'ready');
  await expect(status).toHaveAttribute('data-count', '7');
  expect(downloads.filter(url => url.endsWith('.gz')).length).toBe(gzipDownloads);
  await expect(page.getByTestId('errors')).toBeEmpty();
  expect(errors).toEqual([]);
});

test('without a route, taller obstructions stay visible farther out with inclusive AGL cutoffs', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/test/browser/obstructions.html?zoom=7&route=none');
  const status = page.locator('output[data-state]'), body = page.locator('body');
  const cases: [number, number, number[]][] = [
    [7, 2000, [2, 8]], [7.99, 2000, [2, 8]],
    [8, 1500, [2, 4, 8, 9]], [8.99, 1500, [2, 4, 8, 9]],
    [9, 1000, [2, 3, 4, 8, 9]], [9.99, 1000, [2, 3, 4, 8, 9]],
    [10, 500, [1, 2, 3, 4, 6, 7, 8, 9]],
    [9.99, 1000, [2, 3, 4, 8, 9]], [8.99, 1500, [2, 4, 8, 9]], [7.99, 2000, [2, 8]],
  ];
  for (const [zoom, height, ids] of cases) {
    await page.getByRole('spinbutton', { name: 'Map zoom' }).fill(String(zoom));
    await expect(status).toHaveAttribute('data-state', 'ready');
    await expect(status).toHaveAttribute('data-min-height', String(height));
    await expect(status).toHaveAttribute('data-count', String(ids.length));
    const expected = ids.map(id => `06-${String(id).padStart(6, '0')}`);
    await expect.poll(() => body.getAttribute('data-rendered-obstructions').then(value => JSON.parse(value ?? '[]').sort())).toEqual(expected);
    await expect.poll(() => body.getAttribute('data-published-obstructions').then(value =>
      JSON.parse(value ?? '[]').map((feature: { id: string }) => feature.id).sort())).toEqual(expected);
    await expect(page.getByText(`${ids.length} in view · ≥${height.toLocaleString()} ft AGL`, { exact: true })).toBeVisible();
    if (zoom === 7) await page.screenshot({ path: testInfo.outputPath('tall-obstructions-overview.png') });
  }
  await expect(page.getByTestId('errors')).toBeEmpty();
  expect(errors).toEqual([]);
});

test('off-route obstructions remain visible when routes change and the corridor only adds wider-zoom context', async ({ page }, testInfo) => {
  await page.goto('/test/browser/obstructions.html?zoom=7');
  const status = page.locator('output[data-state]'), body = page.locator('body');
  const rendered = () => body.getAttribute('data-rendered-obstructions').then(value => JSON.parse(value ?? '[]').sort());
  const all = [1, 2, 3, 4, 6, 7, 8, 9].map(id => `06-${String(id).padStart(6, '0')}`);
  await expect(status).toHaveAttribute('data-count', '8');
  await expect.poll(rendered).toEqual(all);
  await page.getByRole('button', { name: 'Move route', exact: true }).click();
  await expect(status).toHaveAttribute('data-count', '2');
  await expect.poll(rendered).toEqual(['06-000002', '06-000008']);
  await page.getByRole('button', { name: 'Clear route' }).click();
  await expect(status).toHaveAttribute('data-count', '2');
  await expect.poll(rendered).toEqual(['06-000002', '06-000008']);
  await page.getByRole('button', { name: 'VP detail' }).click();
  await expect(status).toHaveAttribute('data-count', '8');
  await expect.poll(rendered).toEqual(all);
  for (const action of ['Restore route', 'Move route', 'Clear route']) {
    await page.getByRole('button', { name: action, exact: true }).click();
    await expect(status).toHaveAttribute('data-state', 'ready');
    await expect(status).toHaveAttribute('data-count', '8');
    await expect.poll(rendered).toEqual(all);
  }
  await expect(body).toHaveAttribute('data-map-idle', 'true');
  await page.screenshot({ path: testInfo.outputPath('off-route-obstructions.png') });
  await page.getByRole('button', { name: 'Zoom out' }).click();
  await expect(status).toHaveAttribute('data-state', 'zoom');
  await expect.poll(rendered).toEqual([]);
  await expect(page.getByTestId('errors')).toBeEmpty();
});

test('background obstructions remain visible while route queries are pending and old corridor fades are discarded', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker, pending: (() => void)[] = [];
    window.addEventListener('release-obstruction-queries', () => {
      document.documentElement.dataset.holdObstructionQueries = 'false';
      for (const send of pending.splice(0)) send();
      document.documentElement.dataset.pendingObstructionQueries = '0';
    });
    window.Worker = class extends NativeWorker {
      readonly obstruction: boolean;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options); this.obstruction = String(url).includes('obstructions.worker');
      }
      override postMessage(message: unknown, options: Transferable[] | StructuredSerializeOptions = []) {
        const send = () => {
          if (Array.isArray(options)) super.postMessage(message, options);
          else super.postMessage(message, options);
        };
        if (this.obstruction && document.documentElement.dataset.holdObstructionQueries === 'true') {
          pending.push(send); document.documentElement.dataset.pendingObstructionQueries = String(pending.length);
        } else send();
      }
    };
  });
  await page.goto('/test/browser/obstructions.html?zoom=7&route=none');
  const status = page.locator('output[data-state]'), body = page.locator('body');
  const rendered = () => body.getAttribute('data-rendered-obstructions').then(value => JSON.parse(value ?? '[]').sort());
  const background = ['06-000002', '06-000008'];
  const all = [1, 2, 3, 4, 6, 7, 8, 9].map(id => `06-${String(id).padStart(6, '0')}`);
  const hold = () => page.evaluate(() => { document.documentElement.dataset.holdObstructionQueries = 'true'; });
  const release = () => page.evaluate(() => { window.dispatchEvent(new Event('release-obstruction-queries')); });
  await expect(status).toHaveAttribute('data-state', 'ready');
  await expect.poll(rendered).toEqual(background);
  for (const action of ['Restore route', 'Move route', 'Restore route', 'Clear route']) {
    await hold();
    await page.getByRole('button', { name: action, exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-pending-obstruction-queries', '1');
    await expect(status).toHaveAttribute('data-state', 'loading');
    await expect(body).toHaveAttribute('data-map-idle', 'true');
    await expect.poll(rendered).toEqual(background);
    await expect.poll(() => body.getAttribute('data-published-obstructions').then(value =>
      JSON.parse(value ?? '[]').map((point: { id: string; properties: { routeOpacity: number } }) =>
        [point.id, point.properties.routeOpacity]).sort())).toEqual(background.map(id => [id, 0]));
    if (action === 'Move route') await page.screenshot({ path: testInfo.outputPath('obstructions-during-route-update.png') });
    await release();
    await expect(status).toHaveAttribute('data-state', 'ready');
    await expect.poll(rendered).toEqual(action === 'Restore route' ? all : background);
  }
  await page.getByRole('button', { name: 'Restore route' }).click();
  await expect(status).toHaveAttribute('data-state', 'ready');
  await expect.poll(rendered).toEqual(all);
  await hold();
  await page.getByRole('button', { name: 'Move route', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-pending-obstruction-queries', '1');
  await expect.poll(rendered).toEqual(background);
  await page.getByRole('button', { name: 'Zoom out' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-pending-obstruction-queries', '2');
  await expect(status).toHaveAttribute('data-state', 'loading');
  await expect(body).toHaveAttribute('data-map-idle', 'true');
  await expect.poll(rendered).toEqual([]);
  await release();
  await expect(status).toHaveAttribute('data-state', 'ready');
  await expect(status).toHaveAttribute('data-count', '0');
  await expect.poll(rendered).toEqual([]);
  await expect(page.getByTestId('errors')).toBeEmpty();
});

test('a corrupt obstruction download shows unavailable and can be retried', async ({ page }) => {
  await page.route('**/obstacles/*.geojson.gz', route => route.fulfill({ body: 'bad snapshot' }));
  await page.goto('/test/browser/obstructions.html');
  const status = page.locator('output[data-state]');
  await expect(status).toHaveAttribute('data-state', 'error');
  await expect(page.getByText('Obstructions unavailable · toggle to retry')).toBeVisible();
  await page.unroute('**/obstacles/*.geojson.gz');
  await page.getByRole('switch', { name: /^Obstructions/ }).click();
  await page.getByRole('switch', { name: /^Obstructions/ }).click();
  await expect(status).toHaveAttribute('data-state', 'ready');
  await expect(status).toHaveAttribute('data-count', '8');
  await expect(page.getByTestId('errors')).toBeEmpty();
});

test('a delayed download cannot restore the previous route corridor', async ({ page }) => {
  let release!: () => void, started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { started = resolve; });
  await page.route('**/obstacles/*.geojson.gz', async route => { started(); await held; await route.continue(); });
  await page.goto('/test/browser/obstructions.html?zoom=6.99');
  await requested;
  await page.getByRole('button', { name: 'Move route', exact: true }).click();
  release();
  const status = page.locator('output[data-state]');
  await expect(status).toHaveAttribute('data-state', 'ready');
  await expect(status).toHaveAttribute('data-count', '0');
  await expect.poll(() => page.locator('body').getAttribute('data-rendered-obstructions').then(value => JSON.parse(value ?? '[]').length)).toBe(0);
  await expect(page.getByTestId('errors')).toBeEmpty();
});

test('the app exposes a separate persistent obstruction switch', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Open map layers' }).click();
  const toggle = page.getByRole('switch', { name: /^Obstructions/ });
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await toggle.click();
  await page.reload();
  await expect(page.getByRole('switch', { name: /^Obstructions/ })).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByRole('switch', { name: /^Elevation contours/ })).toHaveAttribute('aria-checked', 'true');
});
