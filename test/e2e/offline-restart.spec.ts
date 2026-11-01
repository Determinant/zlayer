import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { decode } from 'fast-png';

type LegacyReadiness = { preparations: number };

async function offlineSettings(page: Page) {
  await page.getByLabel('Settings and offline downloads').click();
  await page.getByRole('tab', { name: 'Offline', exact: true }).click();
}

// A fresh page does not discard a worker's resident chart Blobs. Restart the
// browser process with the same disk profile and disconnect the actual origin.
// WebKit's offline emulation can also block service-worker responses themselves.
for (const scenario of ['desktop', 'touch', 'retained shell'] as const) test(`saved charts render after a full offline ${scenario} restart`,
  { tag: scenario === 'desktop' ? ['@smoke', '@explicit-density'] : '@explicit-density' },
  async ({ playwright, browserName, baseURL, request }, testInfo) => {
    test.skip(browserName === 'firefox', 'This persistent PWA regression targets Chromium and WebKit.');
    test.setTimeout(120_000);
    const mobile = scenario === 'touch';
    const profile = await mkdtemp(join(tmpdir(), 'zlayer-offline-restart-'));
    let context: BrowserContext | undefined;
    const start = async () => {
      const launched = await playwright[browserName].launchPersistentContext(profile, {
        ...testInfo.project.use.launchOptions,
        viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
        hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1,
      });
      context = launched;
      const page = launched.pages()[0] ?? await launched.newPage();
      await page.clock.setFixedTime(new Date('2026-09-19T12:00:00Z'));
      await page.addInitScript(() => localStorage.setItem('zlayer-ui:welcome-acknowledged', JSON.stringify({ version: 1, value: true })));
      // The fixture's imagery and chart pixels use the same color. Keep imagery
      // unavailable from the start, so only saved charts can satisfy the pixels.
      await page.route('**/basemap.png', route => route.abort('internetdisconnected'));
      return page;
    };
    try {
      await request.post('/__test/reset');
      let page = await start();
      await page.goto(baseURL!);
      await offlineSettings(page);
      await page.getByLabel('Find a state or territory').fill('California');
      await page.locator('.region-row').getByRole('button', { name: 'Download', exact: true }).click();
      await expect(page.locator('.download-card .offline-tag')).toHaveText('Saved');
      await page.getByLabel('Close settings').click();

      // Also reopen a file-backed archive, beyond the 8 MiB memory fallback.
      const bytes = 20 * 1024 * 1024;
      const hash = createHash('sha256').update(new Uint8Array(bytes)).digest('hex');
      const archive = `${baseURL}/chart-data/download-memory/archive.mbtiles?bytes=${bytes}&sha256=${hash}`;
      expect(await page.evaluate(async url => (await fetch(url, { method: 'HEAD' })).status, archive)).toBe(200);
      const retainedRelease = 'aaaaaaaaaaaaaaaa';
      if (scenario === 'retained shell') await page.evaluate(async retainedRelease => {
        // Preserve a previously committed shell, then lose the current page.
        // Assets retain their content hashes; only the release identity changes.
        const release = document.querySelector('meta[name="zlayer-release"]')!.getAttribute('content')!;
        const current = await caches.open(`zlayers-shell-${release}`);
        const retained = await caches.open(`zlayers-shell-${retainedRelease}`);
        for (const request of await current.keys()) {
          const response = (await current.match(request))!;
          await retained.put(request, new URL(request.url).pathname === '/'
            ? new Response((await response.text()).replace(release, retainedRelease), { headers: response.headers }) : response);
        }
        await current.delete('/');
      }, retainedRelease);
      await context!.close(); context = undefined;
      await request.post('/__test/disconnect');

      page = await start();
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      // Cover both airplane-mode reporting and Wi-Fi with no Internet access.
      if (mobile) await page.addInitScript(() => Object.defineProperty(navigator, 'onLine', { get: () => false }));
      if (scenario === 'retained shell') await page.addInitScript(() => {
        // Exercise the old chart hook's wire contract, not just another release
        // marker: it required full preparation with no requireShell field.
        const state: LegacyReadiness = { preparations: 0 };
        Object.assign(window, { legacyChartReadiness: state });
        const postMessage = ServiceWorker.prototype.postMessage;
        ServiceWorker.prototype.postMessage = function (message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) {
          const request = message as { type?: string; requireShell?: boolean };
          if (request?.type === 'prepare-pwa' && request.requireShell === false) {
            state.preparations++;
            message = { type: 'prepare-pwa' };
          }
          postMessage.call(this, message, transfer as StructuredSerializeOptions);
        };
      });
      await page.goto(baseURL!);
      await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });
      if (scenario === 'retained shell') {
        await expect(page.locator('meta[name="zlayer-release"]')).toHaveAttribute('content', retainedRelease);
        expect(await page.evaluate(() => (window as unknown as { legacyChartReadiness: LegacyReadiness })
          .legacyChartReadiness.preparations)).toBeGreaterThan(0);
        // Legacy reads and downloads require a complete usable shell. Readiness
        // through a retained shell must not advertise the active release as ready.
        expect(await page.evaluate(() => new Promise(resolve => {
          const channel = new MessageChannel();
          channel.port1.onmessage = event => { channel.port1.close(); resolve(event.data); };
          navigator.serviceWorker.controller!.postMessage({ type: 'prepare-pwa' }, [channel.port2]);
        }))).toEqual({ ok: true });
        expect(await page.evaluate(() => new Promise(resolve => {
          const channel = new MessageChannel();
          channel.port1.onmessage = event => { channel.port1.close(); resolve(event.data); };
          navigator.serviceWorker.controller!.postMessage({ type: 'app-release' }, [channel.port2]);
        }))).toEqual({ error: 'Application shell is not ready' });
        await expect(page.getByRole('button', { name: 'Update now', exact: true })).toHaveCount(0);
      }
      await expect(page.getByLabel('Chart status', { exact: true })).toContainText('MBTILES');
      await offlineSettings(page);
      await page.locator('.download-card').getByRole('button', { name: 'Verify saved files', exact: true }).click();
      // A validated retained shell also satisfies explicit download readiness.
      await expect(page.locator('.download-card .offline-tag')).toHaveText('Saved');
      await page.getByLabel('Close settings').click();
      const tail = await page.evaluate(async ({ archive, bytes }) => {
        const response = await fetch(archive, { headers: { range: `bytes=${bytes - 4}-${bytes - 1}` } });
        return { status: response.status, bytes: [...new Uint8Array(await response.arrayBuffer())] };
      }, { archive, bytes });
      expect(tail).toEqual({ status: 206, bytes: [0, 0, 0, 0] });
      await expect.poll(async () => {
        const png = decode(await page.locator('.maplibregl-canvas').screenshot());
        let chartPixels = 0;
        for (let i = 0; i < png.data.length; i += png.channels) {
          if ([png.data[i]!, png.data[i + 1]!, png.data[i + 2]!].every(value => value >= 205 && value <= 215)) chartPixels++;
        }
        return chartPixels / (png.width * png.height);
      }, { timeout: 30_000 }).toBeGreaterThan(.25);
      expect(errors).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath('saved-charts-offline.png') });
    } finally {
      await context?.close();
      await request.post('/__test/reset');
      await rm(profile, { recursive: true, force: true });
    }
  });
