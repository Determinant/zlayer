import { test, expect } from '@playwright/test';
import { corridorDistance, corridorOpacity, project, type Point, type Segment } from '../../src/layers/terrain/geometry';
import { METERS_TO_FEET } from '../../src/layers/terrain/contours';
import { terrainColor, TERRAIN_FILL_OPACITY } from '../../src/layers/terrain/palette';
import { terrainMeters } from './terrain-fixture.mjs';

test('the 8 NM fade stays transparent with reduced-precision texture sampling', async ({ browser }, testInfo) => {
  const viewport = { width: 1100, height: 850 }, density = 3, zoom = 9.35;
  const context = await browser.newContext({ viewport, deviceScaleFactor: density });
  try {
    const page = await context.newPage();
    // Desktop GPUs often use full precision even for lowp samplers. Model a
    // mobile texture unit returning half floats, while texelFetch stays precise.
    // Explicit highp samplers must retain full precision on either platform.
    await page.addInitScript(() => {
      const original = WebGL2RenderingContext.prototype.shaderSource;
      WebGL2RenderingContext.prototype.shaderSource = function (shader, source) {
        if (source.includes('u_elevation_stops')) {
          document.body.dataset.terrainPrecisionChecked = 'true';
          if (!source.includes('uniform highp sampler2D u_image;')) {
            source = source.replace(/texture\(u_image,\s*coord\)/g, 'halfSample(texture(u_image, coord))')
              .replace('float getElevation(', 'vec4 halfSample(vec4 v) { return vec4(unpackHalf2x16(packHalf2x16(v.xy)), '
                + 'unpackHalf2x16(packHalf2x16(v.zw))); } float getElevation(');
          }
        }
        original.call(this, shader, source);
      };
    });
    await page.goto(`${testInfo.project.use.baseURL}/test/browser/terrain.html?zoom=${zoom}`);
    await expect(page.locator('output[data-state]')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
    await expect(page.locator('body')).toHaveAttribute('data-map-idle', 'true');
    await expect(page.locator('body')).toHaveAttribute('data-terrain-precision-checked', 'true');
    const center = project([-122.12, 37.42]), worldSize = 512 * 2 ** zoom;
    const a = project([-122.35, 37.5]), b = project([-122.1, 37.5]), c = project([-121.85, 37.2]);
    const samples: { x: number; y: number }[] = [];
    for (let y = 150; y < 800; y += 2) for (let x = 340; x < 1050; x += 2) {
      const point: Point = [center[0] + (x - viewport.width / 2) / worldSize,
        center[1] + (y - viewport.height / 2) / worldSize];
      const distance = corridorDistance(point, [[a, b], [b, c]]);
      if (distance > 7.85 && distance < 8.4) samples.push({ x, y });
    }
    expect(samples.length).toBeGreaterThan(1000);
    for (const mode of ['elevation', 'clearance']) {
      if (mode === 'clearance') {
        await page.getByRole('tab', { name: 'Clearance', exact: true }).click();
        const altitude = page.getByRole('spinbutton', { name: 'Selected altitude' });
        await altitude.fill('3800');
        await altitude.press('Enter');
        await expect(altitude).toHaveValue('3800');
        await expect(page.getByRole('slider', { name: 'Selected altitude' })).toHaveValue('4000');
        await expect(page.locator('body')).toHaveAttribute('data-map-idle', 'true');
      }
      const contrast = await page.locator('.maplibregl-canvas').evaluate((element, { samples, density }) => {
        const canvas = element as HTMLCanvasElement, gl = canvas.getContext('webgl2')!;
        const pixels = new Uint8Array(canvas.width * canvas.height * 4), background = [238, 234, 225];
        gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        let maximum = 0;
        for (const { x, y } of samples) {
          const i = ((canvas.height - y * density - 2) * canvas.width + x * density + 1) * 4;
          for (let channel = 0; channel < 3; channel++) maximum = Math.max(maximum, Math.abs(pixels[i + channel]! - background[channel]!));
        }
        return maximum;
      }, { samples, density });
      await page.screenshot({ path: testInfo.outputPath(`terrain-edge-${mode}.png`) });
      // The fade here is below 0.5%; a bright fringe exceeded 140 color levels.
      expect(contrast, `${mode} must fade into the background at 8 NM`).toBeLessThanOrEqual(4);
    }
    await expect(page.getByTestId('errors')).toBeEmpty();
  } finally { await context.close(); }
});

test('terrain renders through the real worker and map, changes intervals, clears and remounts', async ({ page }, testInfo) => {
  const errors: string[] = [];
  const requests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().includes('/terrain/')) requests.push(request.url()); });
  await page.goto('/test/browser/terrain.html');
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('output[data-state]')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  await expect(page.locator('body')).toHaveAttribute('data-map-idle', 'true', { timeout: 30_000 });
  await expect(page.locator('body')).toHaveAttribute('data-terrain-labels-above-route', 'true');
  await expect.poll(() => page.locator('body').getAttribute('data-contour-features').then(Number)).toBeGreaterThan(0);
  await expect.poll(() => requests.length).toBeGreaterThan(0);
  await expect(page.locator('output[data-state]')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  await page.screenshot({ path: testInfo.outputPath('terrain-overview.png') });
  expect(requests.every(url => new URL(url).pathname.startsWith('/terrain/10/'))).toBe(true);
  await expect(page.getByLabel('Route terrain elevation')).toContainText('1,000 ft bands');
  await expect(page.getByTestId('errors')).toBeEmpty();
  const vectorUpdates = await page.locator('body').getAttribute('data-contour-updates');
  expect(Number(vectorUpdates)).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Small zoom in', exact: true }).click();
  await expect(page.locator('body')).toHaveAttribute('data-map-idle', 'true');
  await expect(page.locator('body')).toHaveAttribute('data-contour-updates', vectorUpdates!);
  await page.getByRole('button', { name: 'Detail', exact: true }).click();
  await expect(page.getByLabel('Route terrain elevation')).toContainText('500 ft contours', { timeout: 30_000 });
  await expect(page.locator('body')).toHaveAttribute('data-map-idle', 'true', { timeout: 30_000 });
  await page.screenshot({ path: testInfo.outputPath('terrain-detail.png') });
  expect(requests.some(url => new URL(url).pathname.startsWith('/terrain/12/'))).toBe(true);
  const afterDetail = requests.length;
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await expect(page.getByLabel('Route terrain elevation')).toContainText('1,000 ft bands', { timeout: 30_000 });
  await expect(page.locator('body')).toHaveAttribute('data-map-idle', 'true', { timeout: 30_000 });
  expect(requests.length).toBe(afterDetail); // Revisit cached tiles without invalidating the source on zoom.
  await page.getByRole('button', { name: 'Clear route' }).click();
  await expect(page.locator('output[data-state]')).toHaveAttribute('data-state', 'idle');
  await expect(page.locator('body')).toHaveAttribute('data-contour-features', '0');
  await expect(page.getByLabel('Route terrain elevation')).toHaveCount(0);
  await page.getByRole('button', { name: 'Restore route' }).click();
  await expect(page.locator('output[data-state]')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  await expect.poll(() => page.locator('body').getAttribute('data-contour-features').then(Number)).toBeGreaterThan(0);
  await page.getByRole('switch').click();
  await expect(page.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('output[data-state]')).toHaveAttribute('data-state', 'idle');
  await page.getByRole('switch').click();
  await page.getByRole('button', { name: 'Remount' }).click();
  await expect(page.locator('output[data-state]')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  await expect(page.locator('body')).toHaveAttribute('data-map-idle', 'true', { timeout: 30_000 });
  await expect(page.locator('body')).toHaveAttribute('data-terrain-labels-above-route', 'true');
  await expect.poll(() => page.locator('body').getAttribute('data-contour-features').then(Number)).toBeGreaterThan(0);
  await expect(page.getByTestId('errors')).toBeEmpty();
  expect(errors).toEqual([]);
});

test('contour outlines render at fractional close zoom on a high-density display', async ({ browser }, testInfo) => {
  const context = await browser.newContext({ deviceScaleFactor: 2, viewport: { width: 1100, height: 850 } });
  try {
    const page = await context.newPage();
    await page.goto(`${testInfo.project.use.baseURL}/test/browser/terrain.html?zoom=11.35`);
    await expect(page.locator('output[data-state]')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
    await expect(page.locator('body')).toHaveAttribute('data-map-idle', 'true', { timeout: 30_000 });
    await expect.poll(() => page.locator('body').getAttribute('data-contour-features').then(Number)).toBeGreaterThan(0);
    await expect(page.getByTestId('errors')).toBeEmpty();
    await page.screenshot({ path: testInfo.outputPath('terrain-fractional-retina.png') });
  } finally { await context.close(); }
});

test('retina terrain shading stays aligned with the route across subtiles', async ({ browser }, testInfo) => {
  const viewport = { width: 1100, height: 850 }, density = 2, zoom = 11.35;
  const context = await browser.newContext({ deviceScaleFactor: density, viewport });
  try {
    const page = await context.newPage();
    await page.goto(`${testInfo.project.use.baseURL}/test/browser/terrain.html?zoom=${zoom}`);
    await expect(page.locator('output[data-state]')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
    await expect(page.locator('body')).toHaveAttribute('data-map-idle', 'true');
    await expect(page.getByTestId('errors')).toBeEmpty();

    // Check geographic elevation bands and corridor opacity in the map pixels:
    // load state and vector checks passed even with displaced WebKit shading tiles.
    const center = project([-122.12, 37.42]), worldSize = 512 * 2 ** zoom;
    const a = project([-122.35, 37.5]), b = project([-122.1, 37.5]), c = project([-121.85, 37.2]);
    const segments: Segment[] = [[a, b], [b, c]];
    const background = [238, 234, 225];
    const samples: { x: number; y: number; expected: number[] }[] = [];
    for (const y of [375, 475, 575, 675, 775]) for (const x of [350, 450, 550, 650, 750, 850, 950]) {
      const point: Point = [center[0] + (x - viewport.width / 2) / worldSize,
        center[1] + (y - viewport.height / 2) / worldSize];
      const distance = corridorDistance(point, segments);
      if (distance < 0.4) continue; // Avoid the route's own line and halo.
      const elevation = terrainMeters(...point) * METERS_TO_FEET;
      // Stay clear of band edges, where grid max-pooling and raster sampling can
      // select the adjacent band even with a correctly positioned tile.
      if (elevation % 500 < 50 || elevation % 500 > 450) continue;
      const color = terrainColor(Math.floor(elevation / 500) * 500);
      const alpha = corridorOpacity(distance) * TERRAIN_FILL_OPACITY;
      samples.push({ x, y, expected: background.map((base, i) => Math.round(base * (1 - alpha) + color[i]! * alpha)) });
    }
    expect(samples.length).toBeGreaterThan(15);
    const colors = await page.locator('.maplibregl-canvas').evaluate((element, { samples, density }) => {
      const canvas = element as HTMLCanvasElement, gl = canvas.getContext('webgl2')!;
      return samples.map(({ x, y }) => {
        const radius = 3 * density, size = radius * 2 + 1, pixels = new Uint8Array(size * size * 4);
        gl.readPixels(x * density - radius, canvas.height - y * density - radius - 1,
          size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        // A small patch median excludes thin contour strokes without hiding a
        // displaced tile, which changes the shading over large rectangular areas.
        return [0, 1, 2].map(channel => Array.from({ length: size * size }, (_, i) => pixels[i * 4 + channel]!)
          .sort((a, b) => a - b)[Math.floor(size * size / 2)]!);
      });
    }, { samples, density });
    await page.screenshot({ path: testInfo.outputPath('terrain-retina-alignment.png') });
    for (const [i, sample] of samples.entries()) {
      expect(Math.max(...sample.expected.map((value, channel) => Math.abs(value - colors[i]![channel]!))),
        `Shading at (${sample.x}, ${sample.y}): expected ${sample.expected}, got ${colors[i]}`).toBeLessThanOrEqual(6);
    }
  } finally { await context.close(); }
});

test('terrain help stays tucked away until hovered, focused or tapped', async ({ page, browser, browserName }, testInfo) => {
  await page.goto('/test/browser/terrain.html?zoom=7.5');
  const info = page.getByRole('button', { name: 'About route terrain' });
  const help = page.getByRole('tooltip');
  await expect(help).toHaveCount(0);
  await info.hover();
  await expect(help).toContainText('Full color within 4 NM');
  await help.hover();
  await expect(help).toBeVisible();
  await page.mouse.move(800, 100);
  await expect(help).toHaveCount(0);
  await info.focus();
  await expect(help).toBeVisible();
  await info.press('Escape');
  await expect(help).toHaveCount(0);
  await info.click();
  await expect(help).toBeVisible();
  await page.mouse.click(800, 100);
  await expect(help).toHaveCount(0);
  await expect(page.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: browserName !== 'firefox' });
  try {
    const phone = await context.newPage();
    await phone.goto(`${testInfo.project.use.baseURL}/test/browser/terrain.html?zoom=7.5`);
    await phone.getByRole('button', { name: 'About route terrain' }).tap();
    await expect(phone.getByRole('tooltip')).toBeVisible();
    await expect(phone.getByRole('tooltip')).toContainText('2,000 ft+ clearance');
    await phone.screenshot({ path: testInfo.outputPath('terrain-help-phone.png') });
    await phone.touchscreen.tap(360, 450);
    await expect(phone.getByRole('tooltip')).toHaveCount(0);
    await expect(phone.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  } finally { await context.close(); }
});

test('zoomed-out terrain shows a toolbox hint without downloading elevation', async ({ page }, testInfo) => {
  const requests: string[] = [];
  page.on('request', request => { if (request.url().includes('/terrain/')) requests.push(request.url()); });
  await page.goto('/test/browser/terrain.html?zoom=7.5');
  await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('body')).toHaveAttribute('data-map-idle', 'true');
  await expect(page.locator('output[data-state]')).toHaveAttribute('data-state', 'zoom');
  const legend = page.getByLabel('Route terrain elevation');
  const hint = legend.getByText('Zoom in to see terrain contours');
  await expect(hint).toBeVisible();
  expect(requests).toHaveLength(0);
  await legend.getByRole('tab', { name: 'Clearance', exact: true }).click();
  await expect(hint).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('terrain-zoom-hint.png') });
  expect(requests).toHaveLength(0);
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await expect.poll(() => requests.length).toBeGreaterThan(0);
  await expect(page.locator('output[data-state]')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  await expect(page.locator('body')).toHaveAttribute('data-map-idle', 'true');
  await expect(hint).toHaveCount(0);
  expect(requests.length).toBeGreaterThan(0);
  const before = requests.length;
  await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await expect(page.locator('body')).toHaveAttribute('data-map-idle', 'true');
  await expect(hint).toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-published-contours', '0');
  expect(requests.length).toBe(before);
});

test('panning drops offscreen contours and returning restores cached geometry', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', request => { if (request.url().includes('/terrain/')) requests.push(request.url()); });
  await page.goto('/test/browser/terrain.html');
  await expect(page.locator('output[data-state]')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  await expect(page.locator('body')).toHaveAttribute('data-map-idle', 'true');
  await expect.poll(() => page.locator('body').getAttribute('data-published-contours').then(Number)).toBeGreaterThan(0);
  const before = requests.length;
  await page.getByRole('button', { name: 'Pan away' }).click();
  await expect(page.locator('body')).toHaveAttribute('data-map-idle', 'true');
  await expect(page.locator('body')).toHaveAttribute('data-published-contours', '0');
  expect(requests.length).toBe(before);
  await page.getByRole('button', { name: 'Return to route' }).click();
  await expect(page.locator('body')).toHaveAttribute('data-map-idle', 'true');
  await expect.poll(() => page.locator('body').getAttribute('data-contour-features').then(Number)).toBeGreaterThan(0);
  await expect.poll(() => page.locator('body').getAttribute('data-published-contours').then(Number)).toBeGreaterThan(0);
  expect(requests.length).toBe(before);
});

test('terrain failures follow the visible tiles and clear when those tiles recover', async ({ page }) => {
  await page.route('**/terrain/10/**', route => route.fulfill({ status: 503, body: 'Unavailable' }));
  await page.goto('/test/browser/terrain.html');
  const status = page.locator('output[data-state]');
  const idle = () => expect(page.locator('body')).toHaveAttribute('data-map-idle', 'true', { timeout: 30_000 });
  await expect(status).toHaveAttribute('data-state', 'error', { timeout: 30_000 });
  await idle();

  await page.getByRole('button', { name: 'Pan away', exact: true }).click();
  await expect(status).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  await idle();
  await page.getByRole('button', { name: 'Return to route', exact: true }).click();
  await expect(status).toHaveAttribute('data-state', 'error', { timeout: 30_000 });
  await idle();

  await page.getByRole('button', { name: 'Detail', exact: true }).click();
  await expect(status).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  await idle();
  await expect.poll(() => page.locator('body').getAttribute('data-contour-features').then(Number)).toBeGreaterThan(0);
  const styles = await page.locator('body').getAttribute('data-style-updates');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('body')).toHaveAttribute('data-style-updates', styles!);
  await expect(status).toHaveAttribute('data-state', 'ready');

  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await expect(status).toHaveAttribute('data-state', 'error', { timeout: 30_000 });
  await idle();
  await page.getByRole('button', { name: 'Pan away', exact: true }).click();
  await expect(status).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  await idle();
  await page.unroute('**/terrain/10/**');
  // Returning reloads failed tiles without changing the route or toggling terrain.
  await page.getByRole('button', { name: 'Return to route', exact: true }).click();
  await expect(status).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  await idle();
  await expect.poll(() => page.locator('body').getAttribute('data-contour-features').then(Number)).toBeGreaterThan(0);
});

test('reconnecting retries failed terrain but leaves healthy terrain intact', async ({ page }) => {
  await page.route('**/terrain/**', route => route.fulfill({ status: 503, body: 'Unavailable' }));
  await page.goto('/test/browser/terrain.html');
  await expect(page.locator('output[data-state]')).toHaveAttribute('data-state', 'error', { timeout: 30_000 });
  await page.unroute('**/terrain/**');
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('output[data-state]')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  await expect(page.locator('body')).toHaveAttribute('data-map-idle', 'true');
  const styles = await page.locator('body').getAttribute('data-style-updates');
  const contours = await page.locator('body').getAttribute('data-contour-updates');
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('online'));
  });
  await expect(page.locator('body')).toHaveAttribute('data-style-updates', styles!);
  await expect(page.locator('body')).toHaveAttribute('data-contour-updates', contours!);
  await expect(page.locator('output[data-state]')).toHaveAttribute('data-state', 'ready');
});

test('terrain fetch failure is visible and clearing a loading route cannot restore stale terrain', async ({ page }) => {
  await page.route('**/terrain/**', route => route.fulfill({ status: 503, body: 'Unavailable' }));
  await page.goto('/test/browser/terrain.html');
  await expect(page.locator('output[data-state]')).toHaveAttribute('data-state', 'error', { timeout: 30_000 });
  await expect(page.getByLabel('Route terrain elevation')).toContainText('Terrain incomplete');
  await page.getByRole('button', { name: 'Clear route' }).click();
  await expect(page.locator('output[data-state]')).toHaveAttribute('data-state', 'idle');
  await page.unroute('**/terrain/**');
  await page.getByRole('button', { name: 'Restore route' }).click();
  await page.getByRole('button', { name: 'Clear route' }).click();
  await expect(page.locator('output[data-state]')).toHaveAttribute('data-state', 'idle');
  await expect(page.getByLabel('Route terrain elevation')).toHaveCount(0);
});

test('phone terrain stays responsive to touch and releases its worker when disabled', async ({ browser, browserName }, testInfo) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3, hasTouch: true, isMobile: browserName !== 'firefox' });
  try {
    const page = await context.newPage();
    const errors: string[] = [], requests: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.url().includes('/terrain/')) requests.push(request.url()); });
    await page.addInitScript(() => {
      const NativeWorker = window.Worker;
      const state = { live: 0, peak: 0, created: 0 };
      const report = () => { document.body.dataset.terrainWorkers = JSON.stringify(state); };
      window.Worker = class extends NativeWorker {
        terrain: boolean;
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          this.terrain = String(url).includes('terrain.worker');
          if (this.terrain) { state.created++; state.peak = Math.max(state.peak, ++state.live); report(); }
        }
        override terminate() {
          if (this.terrain) { state.live--; this.terrain = false; report(); }
          super.terminate();
        }
      };
    });
    if (browserName === 'chromium') {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    }
    await page.goto(`${testInfo.project.use.baseURL}/test/browser/terrain.html?zoom=11`);
    const ready = async () => {
      await expect(page.locator('output[data-state]')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
      await expect(page.locator('body')).toHaveAttribute('data-map-idle', 'true', { timeout: 30_000 });
    };
    const workers = async () => JSON.parse((await page.locator('body').getAttribute('data-terrain-workers'))!) as {
      live: number; peak: number; created: number;
    };
    await ready();
    const camera = await page.locator('body').getAttribute('data-map-camera');
    const before = requests.length;
    const legend = page.getByLabel('Route terrain elevation');
    await legend.getByRole('tab', { name: 'Clearance', exact: true }).tap();
    const altitude = legend.getByRole('spinbutton', { name: 'Selected altitude' });
    await altitude.fill('6500');
    await altitude.press('Enter');
    const slider = legend.getByRole('slider', { name: 'Selected altitude' });
    await expect(slider).toHaveValue('6500');
    const box = (await slider.boundingBox())!;
    await page.touchscreen.tap(box.x + box.width * 0.65, box.y + box.height / 2);
    await expect.poll(() => slider.inputValue().then(Number)).toBeGreaterThan(10000);
    expect(Number(await slider.inputValue()) % 500).toBe(0);
    await expect(altitude).toHaveValue(await slider.inputValue());
    await ready();
    expect(requests.length).toBe(before);
    await expect(page.locator('body')).toHaveAttribute('data-map-camera', camera!);
    expect(await workers()).toEqual({ live: 1, peak: 1, created: 1 });
    await page.screenshot({ path: testInfo.outputPath('terrain-phone-throttled.png') });
    for (let i = 0; i < 3; i++) {
      await page.getByRole('switch').tap();
      await expect(page.locator('output[data-state]')).toHaveAttribute('data-state', 'idle');
      await expect.poll(async () => (await workers()).live).toBe(0);
      await page.getByRole('switch').tap();
      await ready();
      expect((await workers()).live).toBe(1);
    }
    await page.getByRole('button', { name: 'Clear route', exact: true }).tap();
    await expect(page.locator('output[data-state]')).toHaveAttribute('data-state', 'idle');
    await expect.poll(async () => (await workers()).live).toBe(0);
    expect((await workers()).peak).toBe(1);
    await expect(page.getByTestId('errors')).toBeEmpty();
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test('altitude controls change clearance colors while reusing elevation and contour geometry', async ({ page }, testInfo) => {
  const requests: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().includes('/terrain/')) requests.push(request.url()); });
  await page.goto('/test/browser/terrain.html');
  await expect(page.locator('output[data-state]')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  await expect(page.locator('body')).toHaveAttribute('data-map-idle', 'true');
  const before = requests.length;
  const contourUpdates = await page.locator('body').getAttribute('data-contour-updates');
  const legend = page.getByLabel('Route terrain elevation');
  const elevationTab = legend.getByRole('tab', { name: 'Elevation', exact: true });
  const clearanceTab = legend.getByRole('tab', { name: 'Clearance', exact: true });
  const slider = legend.getByRole('slider', { name: 'Selected altitude' });
  const altitudeInput = legend.getByRole('spinbutton', { name: 'Selected altitude' });
  await expect(elevationTab).toHaveAttribute('aria-selected', 'true');
  await expect(legend.getByRole('tabpanel', { name: 'Elevation', exact: true })).toBeVisible();
  await expect(slider).toHaveCount(0);
  await expect(altitudeInput).toHaveCount(0);
  await elevationTab.focus();
  await elevationTab.press('ArrowRight');
  await expect(clearanceTab).toBeFocused();
  await expect(clearanceTab).toHaveAttribute('aria-selected', 'true');
  await expect(slider).toHaveValue('4500');
  await expect(altitudeInput).toHaveValue('4500');
  await slider.focus();
  await slider.press('ArrowRight');
  await expect(slider).toHaveValue('5000');
  await expect(altitudeInput).toHaveValue('5000');
  await slider.press('ArrowLeft');
  await expect(slider).toHaveValue('4500');
  await expect(altitudeInput).toHaveValue('4500');
  const camera = await page.locator('body').getAttribute('data-map-camera');
  const coreColor = (x = 550) => page.locator('.maplibregl-canvas').evaluate((canvas, x) => {
    const surface = canvas as HTMLCanvasElement;
    const gl = surface.getContext('webgl2')!;
    const pixel = new Uint8Array(4);
    const scale = surface.width / surface.clientWidth;
    gl.readPixels(Math.floor(x * scale), surface.height - Math.floor(390 * scale) - 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    return [...pixel];
  }, x);
  let styles = Number(await page.locator('body').getAttribute('data-style-updates'));
  await slider.focus();
  await slider.press('Home');
  await expect(slider).toHaveValue('0');
  await expect(clearanceTab).toHaveAttribute('aria-selected', 'true');
  await expect(altitudeInput).toHaveValue('0');
  await expect.poll(() => page.locator('body').getAttribute('data-style-updates').then(Number)).toBeGreaterThan(styles);
  await expect(page.locator('body')).toHaveAttribute('data-map-idle', 'true');
  const red = await coreColor();
  expect(red[0]! - red[1]!).toBeGreaterThan(70);
  await page.screenshot({ path: testInfo.outputPath('terrain-clearance-red.png') });
  styles = Number(await page.locator('body').getAttribute('data-style-updates'));
  await slider.press('End');
  await expect(slider).toHaveValue('25000');
  await expect(altitudeInput).toHaveValue('25000');
  await expect.poll(() => page.locator('body').getAttribute('data-style-updates').then(Number)).toBeGreaterThan(styles);
  await expect(page.locator('body')).toHaveAttribute('data-map-idle', 'true');
  expect(await coreColor()).toEqual(await coreColor(1100)); // Same base map as outside the terrain corridor.
  await page.screenshot({ path: testInfo.outputPath('terrain-clearance-unshaded.png') });
  await expect(page.locator('body')).toHaveAttribute('data-contour-updates', contourUpdates!);
  expect(requests.length).toBe(before);
  await elevationTab.click();
  await expect(legend.getByText('Below 1,000 ft unshaded')).toBeVisible();
  await expect(slider).toHaveCount(0);
  await expect(altitudeInput).toHaveCount(0);
  await clearanceTab.click();
  await expect(slider).toHaveValue('25000');
  await expect(altitudeInput).toHaveValue('25000');
  const box = (await slider.boundingBox())!;
  await page.mouse.move(box.x + box.width - 7, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.18, box.y + box.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect.poll(() => slider.inputValue().then(Number)).toBeLessThan(6000);
  await expect.poll(() => slider.inputValue().then(Number)).toBeGreaterThan(3000);
  expect(Number(await slider.inputValue()) % 500).toBe(0);
  await expect(page.locator('body')).toHaveAttribute('data-map-idle', 'true');
  await expect(page.locator('body')).toHaveAttribute('data-map-camera', camera!);
  await expect(page.locator('body')).toHaveAttribute('data-contour-updates', contourUpdates!);
  expect(requests.length).toBe(before);
  await page.screenshot({ path: testInfo.outputPath('terrain-clearance-drag.png') });
  const draggedAltitude = await slider.inputValue();
  await expect(altitudeInput).toHaveValue(draggedAltitude);
  await altitudeInput.fill('6000');
  await expect(slider).toHaveValue(draggedAltitude); // Keep incomplete typing out of the map until committed.
  styles = Number(await page.locator('body').getAttribute('data-style-updates'));
  await altitudeInput.press('Enter');
  await expect(slider).toHaveValue('6000');
  await expect.poll(() => page.locator('body').getAttribute('data-style-updates').then(Number)).toBeGreaterThan(styles);
  await expect(page.locator('body')).toHaveAttribute('data-map-idle', 'true');
  expect(await coreColor()).toEqual(await coreColor(1100));
  await altitudeInput.fill('4351');
  await altitudeInput.press('Tab');
  await expect(slider).toHaveValue('4500');
  await expect(slider).toHaveAttribute('aria-valuetext', '4,500 feet MSL');
  await expect(altitudeInput).toHaveValue('4400');
  await altitudeInput.fill('30000');
  await altitudeInput.press('Enter');
  await expect(slider).toHaveValue('25000');
  await expect(altitudeInput).toHaveValue('25000');
  await altitudeInput.fill('');
  await altitudeInput.press('Tab');
  await expect(slider).toHaveValue('25000');
  await expect(altitudeInput).toHaveValue('25000');
  await altitudeInput.fill('-100');
  await altitudeInput.press('Enter');
  await expect(slider).toHaveValue('0');
  await expect(altitudeInput).toHaveValue('0');
  await altitudeInput.fill('6000');
  await altitudeInput.press('Escape');
  await expect(slider).toHaveValue('0');
  await expect(altitudeInput).toHaveValue('0');
  await expect(page.locator('body')).toHaveAttribute('data-map-idle', 'true');
  await expect(page.locator('body')).toHaveAttribute('data-map-camera', camera!);
  await expect(page.locator('body')).toHaveAttribute('data-contour-updates', contourUpdates!);
  expect(requests.length).toBe(before);
  await expect(page.getByTestId('errors')).toBeEmpty();
  expect(errors).toEqual([]);
});
