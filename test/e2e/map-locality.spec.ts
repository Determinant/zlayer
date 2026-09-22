import { expect, test } from '@playwright/test';

declare global {
  interface Window { mapLocality: { uploads: Record<string, number>; draws: number } }
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`${viewport.width}px map viewport`, () => {
    test.use({ viewport });

    test('pan, zoom and shell updates reuse navigation data and let the renderer become idle', async ({ page }, testInfo) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => {
        localStorage.setItem('zlayers-map-preferences-v1', JSON.stringify({ version: 2, ownshipEnabled: false }));
        localStorage.setItem('zlayers-map-view-v1', JSON.stringify({ version: 1, center: [-119.7, 34.4], zoom: 9, bearing: 0, pitch: 0 }));
        const audit = window.mapLocality = { uploads: {} as Record<string, number>, draws: 0 };
        const post = Worker.prototype.postMessage;
        Worker.prototype.postMessage = function(message, options) {
          // MapLibre's loadData RPC rebuilds a GeoJSON index. Ordinary tile requests
          // are expected while moving; resending unchanged national data is not.
          if (message?.type === 'LD' && message.data?.source?.startsWith('nav-')) {
            const id = message.data.source as string;
            audit.uploads[id] = (audit.uploads[id] ?? 0) + 1;
          }
          return post.call(this, message, options as StructuredSerializeOptions);
        };
        for (const prototype of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) {
          for (const key of ['drawArrays', 'drawElements'] as const) {
            const draw = prototype[key];
            prototype[key] = function(...args: number[]) {
              if ((this.canvas as HTMLCanvasElement).classList?.contains('maplibregl-canvas')) audit.draws++;
              return Reflect.apply(draw, this, args);
            };
          }
        }
      });
      await page.goto('/');
      await expect(page.locator('.app-shell')).toHaveAttribute('aria-busy', 'false');
      const canvas = page.locator('.maplibregl-canvas');
      await canvas.evaluate(element => element.setAttribute('data-original-map', 'true'));
      const idle = () => expect.poll(async () => {
        const before = await page.evaluate(() => window.mapLocality.draws);
        await page.waitForTimeout(300);
        return (await page.evaluate(() => window.mapLocality.draws)) - before;
      }).toBe(0);
      await idle();
      const initial = await page.evaluate(() => structuredClone(window.mapLocality));
      expect(initial.draws).toBeGreaterThan(0);
      expect(initial.uploads['nav-airports']).toBeGreaterThan(0);
      expect(initial.uploads['nav-fixes']).toBeGreaterThan(0);
      for (let i = 0; i < 3; i++) {
        await page.getByLabel('Settings and offline downloads').click();
        await page.getByLabel('Close settings').click();
        await page.getByRole('button', { name: 'Open map layers', exact: true }).click();
        await page.getByRole('button', { name: 'Close map layers', exact: true }).click();
      }
      const camera = () => page.evaluate(() => JSON.parse(localStorage.getItem('zlayers-map-view-v1')!));
      const start = await camera();
      const box = (await canvas.boundingBox())!;
      for (const direction of [1, -1, 1]) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 + direction * 90, box.y + box.height / 2 + 30, { steps: 18 });
        await page.mouse.up();
        await idle();
      }
      await expect.poll(camera).not.toEqual(start);
      await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
      await expect.poll(async () => (await camera()).zoom).toBe(start.zoom + 1);
      await idle();
      const final = await page.evaluate(() => structuredClone(window.mapLocality));
      expect(final.draws).toBeGreaterThan(initial.draws);
      expect(final.uploads).toEqual(initial.uploads);
      await expect(page.locator('.maplibregl-canvas[data-original-map="true"]')).toHaveCount(1);
      expect(errors).toEqual([]);
      await testInfo.attach('map-locality.json', { body: JSON.stringify({ viewport, initial, final }), contentType: 'application/json' });
    });
  });
}
