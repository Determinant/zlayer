import { test as base, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { WEATHER_NOW } from '../fixtures/awc-advisories';
import { FORECAST_REQUESTS, RAW_WEATHER_REQUESTS } from './weather-requests';

// Exercise durable storage in a fresh real profile. WebKit's ephemeral context
// can drop CacheStorage bodies when its final document unloads.
const test = base.extend({
  context: async ({ playwright, browserName, baseURL, headless }, use, testInfo) => {
    const profile = testInfo.outputPath('profile');
    await mkdir(profile, { recursive: true });
    const context = await playwright[browserName].launchPersistentContext(profile, { baseURL: baseURL!, headless });
    try { await use(context); } finally { await context.close(); }
  },
});
test.beforeEach(async ({ request, context }) => {
  await request.post('/__test/reset');
  await context.route(RAW_WEATHER_REQUESTS, route => route.abort());
});

test('prepared HRRR grids require the requested identity and never fetch raw NOAA in the browser', async ({ page }) => {
  const raw: string[] = [];
  page.on('request', request => { if (RAW_WEATHER_REQUESTS.test(request.url())) raw.push(request.url()); });
  await page.route('**/*.zwp.gz', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'x-weather-artifact': '0'.repeat(64) } });
  });
  await page.clock.install({ time: WEATHER_NOW });
  await page.goto('/test/browser/weather-native.html');
  await expect(page.evaluate(() => window.nativeWeather.load('clouds', true))).rejects.toThrow(/identity/);
  expect(raw).toEqual([]);
});

test('old converted floats migrate to compact bands with every source blocked', async ({ page, request }) => {
  await page.clock.install({ time: WEATHER_NOW });
  await page.goto('/test/browser/weather-native.html');
  const expected = await page.evaluate(() => window.nativeWeather.load('clouds', true));
  await page.evaluate(() => window.nativeWeather.legacyCloud());
  await page.reload(); await page.route(FORECAST_REQUESTS, route => route.abort());
  expect(await page.evaluate(() => window.nativeWeather.load('clouds', false))).toEqual(expected);
  expect(await page.evaluate(async () => {
    const keys = await (await caches.open('zlayers-plugin-files-v1:weather-awc:converted-grids')).keys();
    return keys.length === 1 && decodeURIComponent(keys[0]!.url).includes('packed-v1/');
  })).toBe(true);
  expect((await (await request.get('/__test/awc-counts')).json()).nativeFiles).toBe(0);
});

test('wind altitudes share prepared sources, preserve MSL/flight-level identity and reopen offline', async ({ page, request }) => {
  test.setTimeout(120_000);
  await page.clock.setFixedTime(WEATHER_NOW);
  await page.goto('/test/browser/weather-native.html');
  const reads = async () => (await (await request.get('/__test/awc-counts')).json()).nativeFiles;
  const msl = await page.evaluate(() => window.nativeWeather.wind(5000, true));
  expect(msl.values[0]).toBe(5000); expect(msl.values[3]).toBe(10);
  expect(await reads()).toBe(0);
  const nearby = await page.evaluate(() => window.nativeWeather.wind(5500, true));
  expect(nearby.values[0]).toBe(5500); expect(nearby.values.slice(1)).toEqual(msl.values.slice(1));
  expect(await reads()).toBe(0); // Native pressure inputs were prepared before the browser opened.
  const flightLevel = await page.evaluate(() => window.nativeWeather.wind(18000, true));
  // The fixture's forecast heights intentionally differ from standard atmosphere.
  expect(flightLevel.values[0]).toBeGreaterThan(18730); expect(flightLevel.values[0]).toBeLessThan(19720);
  expect(flightLevel.values.slice(1)).toEqual(msl.values.slice(1));
  expect(await reads()).toBe(0);
  // FL430 selects native bracketing pressures; derived floating-point pressures
  // are never part of the server artifact identity.
  const high = await page.evaluate(() => window.nativeWeather.wind(43000, true));
  expect(high.values[3]).toBe(10);
  const acquired = await reads();
  await page.reload(); await page.route(FORECAST_REQUESTS, route => route.abort());
  for (const [altitude, expected] of [[5000, msl], [5500, nearby], [18000, flightLevel], [43000, high]] as const) {
    expect(await page.evaluate(altitude => window.nativeWeather.wind(altitude, false), altitude)).toEqual(expected);
  }
  expect(await reads()).toBe(acquired);
});

test('a cold wind response does not block ready cloud forecasts from loading and saving', async ({ page }) => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/weather/grids/winds/*.zwp.gz', async route => {
    entered(); await held; await route.continue();
  });
  await page.clock.setFixedTime(WEATHER_NOW);
  await page.goto('/test/browser/weather-native.html');
  const wind = page.evaluate(() => window.nativeWeather.wind(5000, true));
  try {
    await started;
    await page.evaluate(() => {
      void window.nativeWeather.load('clouds', true).then(value => Reflect.set(window, 'readyCloud', value));
    });
    await expect.poll(() => page.evaluate(() => Reflect.get(window, 'readyCloud')?.values[0]), { timeout: 15_000 }).toBe(75);
    expect(await page.evaluate(() => window.nativeWeather.load('clouds', false)))
      .toEqual(await page.evaluate(() => Reflect.get(window, 'readyCloud')));
  } finally { release(); await wind; }
});

test('the selected forecast paints before its persistent save completes', async ({ page }) => {
  await page.addInitScript(() => {
    const original = Cache.prototype.put;
    let held = false;
    Cache.prototype.put = async function(request, response) {
      const url = request instanceof Request ? request.url : String(request);
      if (!held && decodeURIComponent(url).includes('packed-v1/')) {
        held = true;
        await new Promise<void>(resolve => { Object.assign(window, { releaseWeatherSave: resolve }); });
      }
      return original.call(this, request, response);
    };
  });
  const now = WEATHER_NOW;
  await page.clock.install({ time: now });
  await page.goto('/test/browser/weather-grids.html?native');
  await expect.poll(() => page.evaluate(() => window.weatherGridFixture?.controller.getSnapshot().gridDisplay?.data.frame.validTime)).toBe(now);
  await page.waitForFunction(() => typeof Reflect.get(window, 'releaseWeatherSave') === 'function');
  const before = await page.evaluate(() => window.weatherGridFixture.controller.getSnapshot().grid.preparation);
  expect(before?.ready).toBe(0); expect(before?.limited).toBeUndefined();
  await page.evaluate(() => Reflect.get(window, 'releaseWeatherSave')());
  await page.waitForFunction(() => {
    const p = window.weatherGridFixture.controller.getSnapshot().grid.preparation; return p && p.ready === p.total;
  });
  expect(await page.evaluate(() => window.weatherGridFixture.textureUploads)).toBe(1);
});

test('legacy proxy catalogs cannot pair their index offsets with the new HRRR mirror', async ({ page }) => {
  await page.clock.install({ time: WEATHER_NOW });
  await page.goto('/test/browser/weather-native.html');
  const expected = await page.evaluate(() => window.nativeWeather.load('clouds', true));
  await page.evaluate(() => {
    const key = 'zlayer-plugin:weather-awc:grid-clouds';
    const saved = JSON.parse(localStorage.getItem(key)!);
    delete saved.hrrrSource;
    localStorage.setItem(key, JSON.stringify(saved));
  });
  await page.reload();
  await expect(page.evaluate(() => window.nativeWeather.load('clouds', false))).rejects.toThrow(/No saved forecast metadata/);
  expect(await page.evaluate(() => window.nativeWeather.load('clouds', true))).toEqual(expected);
});

test('saves every cloud time in the background, then browses the whole timeline offline', async ({ page, request }) => {
  test.setTimeout(120_000);
  const now = WEATHER_NOW;
  await page.clock.install({ time: now + 40 * 60_000 });
  await page.goto('/test/browser/weather-grids.html?native');
  const displayed = () => page.evaluate(() => window.weatherGridFixture.controller.getSnapshot().gridDisplay?.data.frame.validTime);
  await expect.poll(displayed, { timeout: 90_000 }).toBe(now);
  await expect.poll(() => page.evaluate(() => window.weatherGridFixture.controller.getSnapshot().grid.preparation), { timeout: 90_000 })
    .toEqual({ ready: 18, total: 18, failed: 0 });
  expect(await displayed()).toBe(now);
  expect(await page.evaluate(() => window.weatherGridFixture.textureUploads)).toBe(1);
  expect((await (await request.get('/__test/awc-counts')).json()).nativeFiles).toBe(0);
  await page.route(FORECAST_REQUESTS, route => route.abort());
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { get: () => false }); window.dispatchEvent(new Event('offline'));
  });
  for (let hour = 1; hour < 18; hour++) {
    await page.getByRole('button', { name: 'Next weather time' }).click();
    await expect.poll(displayed).toBe(now + hour * 3600000);
    await expect.poll(() => page.evaluate(() => window.weatherGridFixture.value())).toBe([75, 0, 25, 50, 10][hour % 5]);
  }
  await expect(page.getByRole('button', { name: 'Next weather time' })).toBeDisabled();
  expect((await (await request.get('/__test/awc-counts')).json()).nativeFiles).toBe(0);
});

test('Next and Prev replace cloud/icing pixels with one upload per frame and none for repeated selections', async ({ page, request }) => {
  const now = WEATHER_NOW;
  // In the latter half of an hour, Now must not already use the next stop.
  await page.clock.install({ time: now + 40 * 60_000 });
  await page.goto('/test/browser/weather-grids.html?native');
  const shown = () => page.evaluate(() => {
    const fixture = window.weatherGridFixture;
    return { time: fixture.controller.getSnapshot().gridDisplay?.data.frame.validTime, value: fixture.value() };
  });
  const pixel = () => page.evaluate(() => window.weatherGridFixture.pixel());
  const uploads = () => page.evaluate(() => window.weatherGridFixture.textureUploads);
  const settle = () => page.evaluate(() => new Promise<void>(resolve => {
    const { map } = window.weatherGridFixture; map.once('idle', () => resolve()); map.triggerRepaint();
  }));
  const next = page.getByRole('button', { name: 'Next weather time' });
  const previous = page.getByRole('button', { name: 'Previous weather time' });
  for (const [mode, initial, final] of [['cloudCover', 75, 25], ['icingSeverity', 3, 4]] as const) {
    if (mode === 'icingSeverity') await page.evaluate(mode => {
      const { controller } = window.weatherGridFixture;
      controller.selectTime(null); controller.change({ awcGridMode: mode, awcSldOverlay: false });
    }, mode);
    await expect.poll(shown, { timeout: 30_000 }).toEqual({ time: now, value: initial });
    await expect.poll(pixel).not.toEqual([255, 255, 255, 255]);
    const firstPixel = await pixel();
    await settle();
    const initialUploads = await uploads();
    if (mode === 'cloudCover') expect(initialUploads).toBe(1);
    await next.click();
    await expect.poll(shown).toEqual({ time: now + 3600000, value: 0 });
    await expect.poll(pixel).toEqual([255, 255, 255, 255]);
    await settle(); expect(await uploads()).toBe(initialUploads + 1);
    await next.click();
    await expect.poll(shown).toEqual({ time: now + 7200000, value: final });
    await expect.poll(pixel).not.toEqual([255, 255, 255, 255]);
    await expect.poll(pixel).not.toEqual(firstPixel);
    await settle(); expect(await uploads()).toBe(initialUploads + 2);
    await page.waitForFunction(() => {
      const p = window.weatherGridFixture.controller.getSnapshot().grid.preparation; return p && p.ready === p.total;
    });
    const acquired = (await (await request.get('/__test/awc-counts')).json()).nativeFiles;
    await previous.click();
    await expect.poll(shown).toEqual({ time: now + 3600000, value: 0 });
    await expect.poll(pixel).toEqual([255, 255, 255, 255]);
    await settle(); expect(await uploads()).toBe(initialUploads + 3);
    await previous.click();
    await expect.poll(shown).toEqual({ time: now, value: initial });
    await expect.poll(pixel).toEqual(firstPixel);
    await settle(); expect(await uploads()).toBe(initialUploads + 4);
    await page.evaluate(() => {
      const { controller } = window.weatherGridFixture, time = controller.getSnapshot().selectedTime;
      for (let n = 0; n < 20; n++) controller.selectTime(time);
    });
    await settle(); expect(await uploads()).toBe(initialUploads + 4);
    expect((await (await request.get('/__test/awc-counts')).json()).nativeFiles).toBe(acquired);
  }
  expect(await page.evaluate(() => window.weatherGridFixture.errors)).toEqual([]);
});

test('the clock passing a pinned forecast cannot insert a duplicate Now step before the next frame', async ({ page }) => {
  const hour = WEATHER_NOW;
  await page.clock.install({ time: hour + 40 * 60_000 });
  await page.goto('/test/browser/weather-grids.html?native');
  const shown = () => page.evaluate(() => window.weatherGridFixture.controller.getSnapshot().gridDisplay?.data.frame.validTime);
  await expect.poll(shown, { timeout: 30_000 }).toBe(hour);
  const next = page.getByRole('button', { name: 'Next weather time' });
  await next.click(); await expect.poll(shown).toBe(hour + 3600000);
  await page.clock.fastForward(21 * 60_000);
  await expect(page.locator('.awc-time-mark').first()).toHaveAttribute('title', 'Sep 22 · 22:00Z');
  await next.click(); await expect.poll(shown).toBe(hour + 7200000);
  await expect(page.getByRole('slider', { name: 'Weather forecast time' })).toHaveAttribute('aria-valuetext', 'Sep 22 · 23:00Z');
});

test('prepared grids share work between windows, reopen offline, and repair from the server cache', async ({ page, context, request }) => {
  await page.clock.install({ time: WEATHER_NOW });
  await page.goto('/test/browser/weather-native.html');
  await expect.poll(() => page.evaluate(() => !!window.nativeWeather)).toBe(true);
  const clouds = await page.evaluate(() => window.nativeWeather.load('clouds', true));
  expect(clouds).toEqual({ frames: 19, values: [75, 3280, 19690, 9840, 14760] });
  const first = await (await request.get('/__test/awc-counts')).json();
  expect(first.nativeFiles).toBe(0);
  expect(await page.evaluate(async () => (await (await caches.open('zlayers-plugin-files-v1:weather-awc:converted-grids')).keys()).length)).toBe(1);
  await page.evaluate(() => window.nativeWeather.load('clouds', true));
  expect((await (await request.get('/__test/awc-counts')).json()).nativeFiles).toBe(first.nativeFiles);
  const second = await context.newPage();
  await second.clock.install({ time: WEATHER_NOW });
  await second.goto('/test/browser/weather-native.html');
  await expect.poll(() => second.evaluate(() => !!window.nativeWeather)).toBe(true);
  const values = await Promise.all([page, second].map(tab => tab.evaluate(() => window.nativeWeather.load('icing', true))));
  expect(values).toEqual([{ frames: 1080, values: [70,3,0.25] }, { frames: 1080, values: [70,3,0.25] }]);
  const acquired = (await (await request.get('/__test/awc-counts')).json()).nativeFiles;
  expect(acquired, 'published fields serve both windows without source acquisition').toBe(0);
  await second.close();
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!window.nativeWeather)).toBe(true);
  await page.route(FORECAST_REQUESTS, route => route.abort());
  expect(await page.evaluate(() => window.nativeWeather.load('clouds', false))).toEqual(clouds);
  expect(await page.evaluate(() => window.nativeWeather.load('icing', false))).toEqual(values[0]);
  expect((await (await request.get('/__test/awc-counts')).json()).nativeFiles).toBe(acquired);
  await page.unroute(FORECAST_REQUESTS);
  await page.evaluate(async () => {
    const cache = await caches.open('zlayers-plugin-files-v1:weather-awc:converted-grids');
    const keys = await cache.keys(), key = keys.find(key => key.url.includes('high-resolution-rapid-refresh'))!;
    const old = (await cache.match(key))!;
    await cache.put(key, new Response(new Uint8Array(Number(old.headers.get('content-length'))), { headers: old.headers }));
  });
  expect(await page.evaluate(() => window.nativeWeather.load('clouds', true))).toEqual(clouds);
  expect((await (await request.get('/__test/awc-counts')).json()).nativeFiles).toBe(acquired); // Repair uses the shared prepared artifact without rereading GRIBs.
});

test('cloud, icing and wind requests reuse one bounded worker, release it when idle and reopen offline', async ({ page }) => {
  await page.addInitScript(() => {
    const counts = { active: 0, peak: 0 };
    Object.assign(window, { weatherWorkerCounts: counts });
    const Original = window.Worker;
    window.Worker = class extends Original {
      private released = false;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options); counts.active++; counts.peak = Math.max(counts.peak, counts.active);
      }
      override terminate() {
        if (!this.released) { this.released = true; counts.active--; }
        super.terminate();
      }
    };
  });
  await page.clock.install({ time: WEATHER_NOW });
  await page.goto('/test/browser/weather-native.html');
  const values = await page.evaluate(() => Promise.all([
    window.nativeWeather.load('clouds', true), window.nativeWeather.load('icing', true), window.nativeWeather.load('winds', true, 850),
  ]));
  expect(await page.evaluate(() => Reflect.get(window, 'weatherWorkerCounts'))).toEqual({ active: 1, peak: 1 });
  await page.clock.fastForward(30_001);
  expect(await page.evaluate(() => Reflect.get(window, 'weatherWorkerCounts'))).toEqual({ active: 0, peak: 1 });
  await page.reload();
  await page.route(FORECAST_REQUESTS, route => route.abort());
  expect(await page.evaluate(() => Promise.all([
    window.nativeWeather.load('clouds', false), window.nativeWeather.load('icing', false), window.nativeWeather.load('winds', false, 850),
  ]))).toEqual(values);
  expect(await page.evaluate(() => Reflect.get(window, 'weatherWorkerCounts'))).toEqual({ active: 1, peak: 1 });
  await page.clock.fastForward(30_001);
  expect(await page.evaluate(() => Reflect.get(window, 'weatherWorkerCounts'))).toEqual({ active: 0, peak: 1 });
});
