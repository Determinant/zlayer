import { test, expect, type Page } from '@playwright/test';
import { mockGps, countWatches, sendFix } from './ownship-fixture';

async function openAhrs(page: Page, permission = 'granted', ownshipEnabled = false) {
  await mockGps(page);
  await page.addInitScript(({ permission, ownshipEnabled }) => {
    localStorage.setItem('zlayers-map-preferences-v1', JSON.stringify({ chartBase: '', ownshipEnabled }));
    try { new DeviceMotionEvent('devicemotion'); }
    catch {
      // Desktop WebKit can expose the hardware interface without a constructor.
      // Test DOM delivery and recovery with the same synthetic inputs there.
      class Motion extends Event {
        constructor(type: string, values: DeviceMotionEventInit = {}) {
          super(type);
          Object.assign(this, { acceleration: null, accelerationIncludingGravity: null, rotationRate: null, interval: 0 }, values);
        }
      }
      Object.defineProperty(window, 'DeviceMotionEvent', { configurable: true, value: Motion });
    }
    Object.defineProperty(DeviceMotionEvent, 'requestPermission', { configurable: true, value: async () => permission });
    // Only the synthetic stream belongs to this test; desktop Chrome can also
    // emit an initial hardware event with null readings.
    window.addEventListener('devicemotion', event => { if (event.isTrusted) event.stopImmediatePropagation(); }, true);
    let rolling = false, yawing = false, noisy = false, vibrating = false, drift = 0, samples = 0, gps = true, speed = 120 * 1852 / 3600;
    let queuedMotion: DeviceMotionEvent[] | null = null;
    let pausedMotion = false;
    let altitude: number | null = 3048;
    window.addEventListener('test-ahrs-gps-lost', () => { gps = false; });
    window.addEventListener('test-ahrs-gps-restored', () => { gps = true; });
    window.addEventListener('test-ahrs-roll', () => { rolling = true; });
    window.addEventListener('test-ahrs-steady', () => { rolling = yawing = false; });
    window.addEventListener('test-ahrs-yaw', () => { yawing = true; });
    window.addEventListener('test-ahrs-drift', event => { drift = (event as CustomEvent<number>).detail; });
    window.addEventListener('test-ahrs-noise', () => { noisy = true; });
    window.addEventListener('test-ahrs-vibration', event => { vibrating = (event as CustomEvent<boolean>).detail; });
    window.addEventListener('test-ahrs-speed', event => { speed = (event as CustomEvent<number>).detail; });
    window.addEventListener('test-ahrs-altitude', event => { altitude = (event as CustomEvent<number | null>).detail; });
    window.addEventListener('test-ahrs-queue-motion', () => { queuedMotion = []; });
    window.addEventListener('test-ahrs-pause-motion', event => { pausedMotion = (event as CustomEvent<boolean>).detail; });
    window.addEventListener('test-ahrs-deliver-motion', () => {
      const pending = queuedMotion ?? [];
      queuedMotion = null;
      for (const event of pending) {
        window.dispatchEvent(event);
        window.dispatchEvent(event); // Duplicate timestamps accompany this queued batch.
      }
    });
    window.addEventListener('test-ahrs-sensors', () => {
      setInterval(() => {
        if (pausedMotion) return;
        const time = ++samples / 50, jitter = noisy ? (samples % 2 ? .5 : -.5) : 0;
        const slow = 2 * Math.PI * .2, fast = 2 * Math.PI * 8;
        const roll = (.8 * Math.sin(slow * time) + 5 / fast * Math.sin(fast * time)) * Math.PI / 180;
        const event = new DeviceMotionEvent('devicemotion', {
          rotationRate: { alpha: vibrating ? -.1 : jitter / 2, beta: yawing ? -15 : vibrating ? -.2 : jitter / 2 - drift,
            gamma: rolling ? -10 : vibrating ? -(.15 + .8 * slow * Math.cos(slow * time) + 5 * Math.cos(fast * time)) : noisy ? .2 + jitter : 0 },
          accelerationIncludingGravity: vibrating
            ? { x: -9.80665 * Math.sin(roll) + 1.6 * Math.sin(2 * Math.PI * 6 * time),
              y: 9.80665 * Math.cos(roll) - .6 * Math.cos(2 * Math.PI * 10 * time), z: -.8 * Math.sin(fast * time) }
            : { x: jitter * .8, y: 9.80665 + jitter * .8, z: jitter * .8 }, interval: 20,
        });
        if (queuedMotion) {
          // Playwright's clock otherwise assigns timeStamp only on first access.
          Object.defineProperty(event, 'timeStamp', { value: performance.now() });
          queuedMotion.push(event);
        } else window.dispatchEvent(event);
      }, 20);
      setInterval(() => { if (gps) window.dispatchEvent(new CustomEvent('test-gps-position', { detail: { speed, altitude, altitudeAccuracy: 10 } })); }, 1000);
    });
  }, { permission, ownshipEnabled });
  await page.goto('/');
  await page.getByRole('button', { name: 'Show AHRS toolbox', exact: true }).click();
  await expect(page.getByRole('region', { name: 'AHRS toolbox', exact: true })).toBeVisible();
}

async function backgroundAhrs(page: Page) {
  await page.getByRole('button', { name: 'Hide AHRS toolbox', exact: true }).click();
  await page.getByRole('alertdialog', { name: 'Stow AHRS?', exact: true })
    .getByRole('button', { name: 'Background', exact: true }).click();
}

test('AHRS keeps GPS and heading when Ownship is disabled, and can restart while Ownship stays disabled', async ({ page }) => {
  await page.clock.install();
  await openAhrs(page, 'granted', true);
  await page.getByRole('button', { name: 'Calibrate', exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-sensors')));
  await page.clock.runFor(12_000);
  await expect(page.getByRole('button', { name: 'Recalibrate', exact: true })).toBeVisible();
  expect(await countWatches(page)).toBe(1);
  const settings = async () => {
    await backgroundAhrs(page);
    await page.getByLabel('Settings and offline downloads').click();
    await page.getByRole('tab', { name: 'Plugins', exact: true }).click();
  };
  const row = (id: string) => page.locator(`.plugin-row[data-plugin="${id}"]`);
  await settings();
  await row('ownship').getByRole('button', { name: /^Disable / }).click();
  await expect(row('ownship').locator('.plugin-status')).toHaveText('Disabled');
  await expect(row('ahrs').locator('.plugin-status')).toHaveText('Enabled');
  expect(await countWatches(page)).toBe(1);
  await page.getByLabel('Close settings').click();
  await page.getByRole('button', { name: 'Show AHRS toolbox', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Recalibrate', exact: true })).toBeVisible();
  await page.clock.runFor(1100);
  const compass = page.getByTestId('hsi-compass');
  const before = await compass.getAttribute('transform');
  await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-yaw')));
  await page.clock.runFor(100);
  await expect(compass).not.toHaveAttribute('transform', before!);
  await expect(page.locator('.ahrs-hsi-readout')).toHaveText(/^HDG /);
  await expect(page.locator('.ahrs-gps')).toHaveText('GPS live');
  await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-steady')));
  await settings();
  await row('ahrs').getByRole('button', { name: /^Disable / }).click();
  await expect.poll(() => countWatches(page)).toBe(0);
  await row('ahrs').getByRole('button', { name: /^Enable / }).click();
  await expect(row('ownship').locator('.plugin-status')).toHaveText('Disabled');
  expect(await countWatches(page), 'enabling the plugin alone does not request GPS').toBe(0);
  await page.getByLabel('Close settings').click();
  await page.getByRole('button', { name: 'Show AHRS toolbox', exact: true }).click();
  await page.getByRole('button', { name: 'Calibrate', exact: true }).click();
  await page.clock.runFor(12_000);
  await expect(page.getByRole('button', { name: 'Recalibrate', exact: true })).toBeVisible();
  await expect(page.locator('.ahrs-gps')).toHaveText('GPS live');
  expect(await countWatches(page)).toBe(1);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  expect(await countWatches(page)).toBe(0);
});

async function mockWakeLock(page: Page, mode: 'granted' | 'pending' | 'denied' | 'unsupported' = 'granted') {
  await page.addInitScript(mode => {
    let requests = 0, held = 0, released = 0;
    const pending: (() => void)[] = [];
    const report = () => Object.assign(document.body.dataset, {
      wakeRequests: String(requests), wakeHeld: String(held), wakeReleased: String(released),
    });
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: mode === 'unsupported' ? undefined : {
      request: async (type: string) => {
        if (type !== 'screen') throw new Error(`Unexpected wake lock: ${type}`);
        requests++; report();
        if (mode === 'denied') throw new DOMException('Power saving', 'NotAllowedError');
        if (mode === 'pending') await new Promise<void>(resolve => pending.push(resolve));
        held++; report();
        const lock = { released: false, release: async () => {
          if (lock.released) return;
          lock.released = true; held--; released++; report();
        } };
        return lock;
      },
    } });
    window.addEventListener('test-wake-grant', () => pending.splice(0).forEach(resolve => resolve()));
  }, mode);
}

test('screen wake lock follows the visible AHRS display, including full screen and Test', async ({ page }) => {
  await page.clock.install();
  await mockWakeLock(page);
  await openAhrs(page);
  const body = page.locator('body');
  await expect(body).not.toHaveAttribute('data-wake-requests');
  await page.getByRole('button', { name: 'Calibrate', exact: true }).click();
  await expect(body).toHaveAttribute('data-wake-held', '1');
  await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-sensors')));
  await page.clock.runFor(12_000);
  await page.getByRole('button', { name: 'Enter full screen', exact: true }).click();
  await page.getByRole('button', { name: 'Exit full screen', exact: true }).click();
  await expect(body).toHaveAttribute('data-wake-requests', '1');
  await expect(body).toHaveAttribute('data-wake-held', '1');

  await backgroundAhrs(page);
  await expect(body).toHaveAttribute('data-wake-held', '0');
  expect(await countWatches(page), 'stowing releases only the wake lock').toBe(1);
  await page.getByRole('button', { name: 'Show AHRS toolbox', exact: true }).click();
  await expect(body).toHaveAttribute('data-wake-held', '1');
  await expect(body).toHaveAttribute('data-wake-requests', '2');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(body).toHaveAttribute('data-wake-held', '0');
  await page.evaluate(() => {
    Reflect.deleteProperty(document, 'hidden');
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(body).toHaveAttribute('data-wake-held', '1');
  await expect(body).toHaveAttribute('data-wake-requests', '3');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(body).toHaveAttribute('data-wake-held', '0');
  await page.getByRole('button', { name: 'Test', exact: true }).click();
  await expect(body).toHaveAttribute('data-wake-held', '1');
  await page.getByRole('button', { name: 'Stop test', exact: true }).click();
  await expect(body).toHaveAttribute('data-wake-held', '0');
  await expect(body).toHaveAttribute('data-wake-released', '4');
});

test('a late screen wake lock is released after stowing or canceling calibration', async ({ page }) => {
  await mockWakeLock(page, 'pending');
  await openAhrs(page);
  const body = page.locator('body');
  await page.getByRole('button', { name: 'Calibrate', exact: true }).click();
  await expect(body).toHaveAttribute('data-wake-requests', '1');
  await backgroundAhrs(page);
  await page.getByRole('button', { name: 'Show AHRS toolbox', exact: true }).click();
  await expect(body).toHaveAttribute('data-wake-requests', '2');
  await page.evaluate(() => window.dispatchEvent(new Event('test-wake-grant')));
  await expect(body).toHaveAttribute('data-wake-held', '1');
  await expect(body).toHaveAttribute('data-wake-released', '1');
  await page.getByRole('button', { name: 'Cancel calibration', exact: true }).click();
  await expect(body).toHaveAttribute('data-wake-held', '0');

  await page.getByRole('button', { name: 'Calibrate', exact: true }).click();
  await expect(body).toHaveAttribute('data-wake-requests', '3');
  await page.getByRole('button', { name: 'Cancel calibration', exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('test-wake-grant')));
  await expect(body).toHaveAttribute('data-wake-held', '0');
  await expect(body).toHaveAttribute('data-wake-released', '3');
});

for (const mode of ['denied', 'unsupported'] as const) {
  test(`a ${mode} screen wake lock does not interrupt AHRS`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await mockWakeLock(page, mode);
    await openAhrs(page);
    await page.getByRole('button', { name: 'Calibrate', exact: true }).click();
    await expect(page.getByRole('progressbar', { name: 'Calibration progress' })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel calibration', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Calibrate', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test('magnetic heading fusion uses absolute orientation and suspends on a field jump', async ({ page }) => {
  test.setTimeout(120_000);
  await page.clock.install();
  await page.addInitScript(() => {
    // Some engines expose non-constructible hardware event interfaces. These
    // fixtures exercise DOM delivery/permissions, not real sensor acquisition.
    class Motion extends Event {
      constructor(type: string, values: DeviceMotionEventInit) { super(type); Object.assign(this, values); }
    }
    class Orientation extends Event {
      constructor(type: string, values: DeviceOrientationEventInit) { super(type); Object.assign(this, values); }
    }
    Object.defineProperty(window, 'DeviceMotionEvent', { configurable: true, value: Motion });
    Object.defineProperty(window, 'DeviceOrientationEvent', { configurable: true, value: Orientation });
    Object.defineProperty(window, 'Magnetometer', { configurable: true, value: undefined });
    Object.defineProperty(DeviceOrientationEvent, 'requestPermission', { configurable: true, value: async () => 'granted' });
    let alpha = 0;
    window.addEventListener('test-magnetic-jump', () => { alpha = 90; });
    window.addEventListener('test-magnetic-start', () => {
      setInterval(() => window.dispatchEvent(new DeviceOrientationEvent('deviceorientationabsolute',
        { alpha, beta: 90, gamma: 0, absolute: true })), 200);
    });
  });
  await openAhrs(page);
  await page.getByRole('button', { name: 'Calibrate', exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-sensors')));
  await page.clock.runFor(12_000);
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('test-ahrs-drift', { detail: .15 }));
    window.dispatchEvent(new Event('test-magnetic-start'));
  });
  await page.locator('.ahrs-diagnostics summary').click();
  // Correlated OS headings may remain uninformative until drift uncertainty
  // exceeds their retained noise floor. Exercise the two-minute drift window.
  await page.clock.runFor(120_000);
  await expect(page.locator('.ahrs-magnetic-counts')).toContainText(/Magnetic fusion: [1-9]\d+ used/);
  await expect(page.locator('.ahrs-diagnostic-readings')).toContainText('Heading σUnknown');
  await page.evaluate(() => window.dispatchEvent(new Event('test-magnetic-jump')));
  await page.clock.runFor(1100);
  await expect(page.locator('.ahrs-magnetic-counts')).toContainText('innovation rejected');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await page.clock.runFor(1000);
  await expect(page.locator('.ahrs-diagnostics')).toHaveCount(0);
});

test('Test below Calibrate animates GS, ALT and HSI without sensors and stops cleanly', async ({ page }, testInfo) => {
  await page.clock.install();
  await openAhrs(page, 'denied');
  // Keep screenshots/resizing from advancing into the next altitude scenario.
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await page.evaluate(() => Object.defineProperty(DeviceMotionEvent, 'requestPermission', {
    configurable: true, value: async () => {
      document.body.dataset.testMotionRequested = 'true';
      return 'denied';
    },
  }));
  const tool = page.getByRole('region', { name: 'AHRS toolbox', exact: true });
  const calibrate = page.getByRole('button', { name: 'Calibrate', exact: true });
  const start = page.getByRole('button', { name: 'Test', exact: true });
  expect((await start.boundingBox())!.y).toBeGreaterThan((await calibrate.boundingBox())!.y);
  await start.click();
  const demo = page.getByRole('region', { name: 'Instrument test', exact: true });
  await expect(demo.getByRole('status')).toHaveText('Test mode · simulated readings');
  await expect(tool.locator('.ahrs-gps')).toHaveText('TEST');
  await page.clock.runFor(100);
  const speed = demo.getByRole('img', { name: /^Ground speed:/ });
  const altitude = demo.getByRole('img', { name: /^GPS altitude:/ });
  const vsi = demo.getByRole('img', { name: /^GPS vertical speed:/ });
  await expect(vsi).toHaveAttribute('aria-label', 'GPS vertical speed: unavailable');
  const reading = async (name: 'speed' | 'altitude') => Number((await (name === 'speed' ? speed : altitude)
    .getAttribute('aria-label'))!.match(/-?\d+/)![0]);
  expect(await reading('speed')).toBe(98);
  expect(await reading('altitude')).toBe(9980);
  const compass = await demo.getByTestId('hsi-compass').getAttribute('transform');
  const deviation = await demo.getByTestId('hsi-deviation').getAttribute('transform');
  const distance = await demo.locator('.ahrs-hsi-readings dd').nth(1).textContent();
  await expect(demo.getByTestId('hsi-invalid')).toHaveCount(0);
  await expect(demo.getByTestId('hsi-heading')).toHaveCount(1);
  await page.clock.runFor(4500);
  expect(await reading('speed')).toBeGreaterThan(100);
  expect(await reading('altitude')).toBeGreaterThan(10000);
  await expect(vsi).toHaveAttribute('aria-label', 'GPS vertical speed: 400 feet per minute');
  await expect(demo.getByTestId('hsi-compass')).not.toHaveAttribute('transform', compass!);
  await expect(demo.getByTestId('hsi-deviation')).not.toHaveAttribute('transform', deviation!);
  await expect(demo.locator('.ahrs-hsi-readings dd').nth(1)).not.toHaveText(distance!);
  await demo.screenshot({ path: testInfo.outputPath('instrument-test.png') });
  await page.setViewportSize({ width: 320, height: 568 });
  await demo.locator('.ahrs-instrument').scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await demo.locator('.ahrs-instrument').screenshot({ path: testInfo.outputPath('instrument-test-mobile.png') });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.clock.runFor(7000); // Allow the damped VSI to follow the descent.
  expect(await reading('speed')).toBeLessThan(100);
  expect(await reading('altitude')).toBeLessThan(10000);
  expect(Number((await vsi.getAttribute('aria-label'))!.match(/-?\d+/)![0])).toBeLessThan(0);
  expect(await countWatches(page)).toBe(0);
  expect(await page.locator('body').getAttribute('data-test-motion-requested')).toBeNull();
  await page.getByRole('button', { name: 'Stop test', exact: true }).click();
  await expect(demo).toHaveCount(0);
  await expect(page.getByRole('img', { name: 'Ground speed: unavailable', exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: 'GPS altitude: unavailable', exact: true })).toBeVisible();
  await page.clock.runFor(100);
  const stopped = await tool.innerHTML();
  await page.clock.runFor(1000);
  expect(await tool.innerHTML()).toBe(stopped);
  await start.click();
  await backgroundAhrs(page);
  await page.getByRole('button', { name: 'Show AHRS toolbox', exact: true }).click();
  await expect(demo).toHaveCount(0);
  await expect(start).toBeVisible();
  expect(await countWatches(page)).toBe(0);
});

test('Test is available after calibration and preserves the selected live HSI route leg', async ({ page }) => {
  await page.clock.install();
  await openAhrs(page);
  await page.getByRole('textbox', { name: 'Add route waypoint', exact: true })
    .fill('370000N1230000W 370000N1210000W 380000N1210000W');
  await page.getByRole('textbox', { name: 'Add route waypoint', exact: true }).press('Enter');
  const leg = page.getByRole('combobox', { name: 'HSI route leg', exact: true });
  await expect(leg.locator('option')).toHaveCount(3);
  await leg.selectOption({ index: 2 });
  const selected = await leg.inputValue();
  await page.getByRole('button', { name: 'Calibrate', exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-sensors')));
  await page.clock.runFor(12_000);
  await page.getByRole('button', { name: 'Test', exact: true }).click();
  await page.clock.runFor(2000);
  expect(await countWatches(page)).toBe(1);
  await page.getByRole('button', { name: 'Stop test', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Recalibrate', exact: true })).toBeVisible();
  await expect(leg).toHaveValue(selected);
  await expect(leg.locator('option')).toHaveCount(3);
  await expect(page.getByRole('img', { name: 'Ground speed: 120 knots', exact: true })).toBeVisible();
  expect(await countWatches(page)).toBe(1);
});

test('Test stays available during calibration and Stop test returns to the completed live session', async ({ page }) => {
  await page.clock.install();
  await openAhrs(page);
  await page.getByRole('button', { name: 'Test', exact: true }).click();
  await page.clock.runFor(500);
  await page.getByRole('button', { name: 'Calibrate', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Instrument test', exact: true })).toHaveCount(0);
  await expect(page.getByRole('progressbar', { name: 'Calibration progress' })).toBeVisible();
  expect(await countWatches(page)).toBe(1);
  await page.getByRole('button', { name: 'Test', exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-sensors')));
  await page.clock.runFor(12_000);
  await expect(page.getByRole('region', { name: 'Instrument test', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Recalibrate', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Stop test', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Instrument test', exact: true })).toHaveCount(0);
  await expect(page.getByTestId('ahrs-moving-horizon')).toBeVisible();
  expect(await countWatches(page)).toBe(1);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  expect(await countWatches(page)).toBe(0);
});

for (const mode of ['no GPS', 'low speed', 'no GPS and sensor noise'] as const) {
  test(`calibration completes with ${mode} and shows a moving reference under its warning`, async ({ page }, testInfo) => {
    await page.clock.install();
    await openAhrs(page);
    await page.evaluate(mode => {
      window.dispatchEvent(mode === 'low speed'
        ? new CustomEvent('test-ahrs-speed', { detail: 5 }) : new Event('test-ahrs-gps-lost'));
      if (mode === 'no GPS and sensor noise') window.dispatchEvent(new Event('test-ahrs-noise'));
    }, mode);
    await page.getByRole('button', { name: 'Calibrate', exact: true }).click();
    await expect(page.getByTestId('ahrs-cross')).toHaveText('Calibration');
    await expect(page.getByTestId('ahrs-moving-horizon')).toHaveCount(0);
    await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-sensors')));
    await page.clock.runFor(12_000);
    await expect(page.getByRole('button', { name: 'Recalibrate', exact: true })).toBeVisible();
    await expect(page.getByRole('progressbar', { name: 'Calibration progress' })).toHaveCount(0);
    const warning = mode === 'low speed' ? 'Low Speed' : 'No GPS';
    await expect(page.getByTestId('ahrs-cross')).toHaveText(warning);
    await expect(page.locator('.ahrs-actions')).toContainText('gravity aiding active');
    await expect(page.locator('.ahrs-gps')).toHaveText(mode === 'low speed' ? 'GPS · low speed' : 'No GPS');
    const horizon = page.getByTestId('ahrs-moving-horizon');
    const before = await horizon.getAttribute('transform');
    await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-roll')));
    await page.clock.runFor(1000);
    await expect(horizon).not.toHaveAttribute('transform', before!);
    await expect(page.getByTestId('ahrs-cross')).toHaveText(warning);
    await page.setViewportSize({ width: 320, height: 568 });
    await page.locator('.ahrs-instrument').screenshot({ path: testInfo.outputPath('ahrs-reference.png') });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => {
      window.dispatchEvent(new Event('test-ahrs-steady'));
      window.dispatchEvent(new Event('test-ahrs-gps-restored'));
      window.dispatchEvent(new CustomEvent('test-ahrs-speed', { detail: 60 }));
    });
    await page.clock.runFor(1100);
    await expect(page.locator('.ahrs-gps')).toHaveText('GPS live');
    await expect(page.getByTestId('ahrs-cross')).toHaveCount(0);
    await expect(page.locator('.ahrs-actions')).toContainText('gravity aiding active');
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    expect(await countWatches(page)).toBe(0);
  });
}

test('queued motion and duplicate timestamps preserve calibration and live attitude', async ({ page }) => {
  await page.clock.install();
  await openAhrs(page);
  await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-gps-lost')));
  await page.getByRole('button', { name: 'Calibrate', exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-sensors')));
  await page.clock.runFor(12_000);
  await expect(page.getByRole('button', { name: 'Recalibrate', exact: true })).toBeVisible();
  const horizon = page.getByTestId('ahrs-moving-horizon');
  const before = await horizon.getAttribute('transform');
  await page.evaluate(() => {
    window.dispatchEvent(new Event('test-ahrs-queue-motion'));
    window.dispatchEvent(new Event('test-ahrs-roll'));
  });
  await page.clock.runFor(600);
  await expect(page.getByTestId('ahrs-cross')).toHaveText('Motion');
  await expect(horizon).toHaveAttribute('transform', before!); // Mark the held attitude as paused.
  await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-deliver-motion')));
  await page.clock.runFor(100);
  await expect(page.getByRole('button', { name: 'Recalibrate', exact: true })).toBeVisible();
  await expect(horizon).toBeVisible();
  await expect(horizon).not.toHaveAttribute('transform', before!);
  await expect(page.getByTestId('ahrs-cross')).toHaveText('No GPS');
  await expect(page.locator('.ahrs-tool')).not.toContainText('Motion timing');
  expect(await countWatches(page)).toBe(1);
});

for (const viewport of [{ width: 390, height: 844 }, { width: 744, height: 1133 }])
test(`scrolling during calibration preserves progress and resumes when motion readings return (${viewport.width}px)`, async ({ page }) => {
  await page.setViewportSize(viewport);
  await page.clock.install();
  await openAhrs(page);
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-gps-lost')));
  await page.getByRole('button', { name: 'Calibrate', exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-sensors')));
  await page.clock.runFor(4000);
  const content = page.locator('.map-edge-ahrs .map-edge-content');
  const progress = page.getByRole('progressbar', { name: 'Calibration progress' });
  await content.evaluate(element => { element.scrollTop = element.scrollHeight; });
  expect(await content.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('test-ahrs-pause-motion', { detail: true })));
  await page.clock.runFor(100); // Publish the final readings before the pause.
  const before = await progress.getAttribute('value');
  expect(Number(before)).toBeGreaterThan(.35);
  await content.evaluate(element => { element.scrollTop = 0; });
  await page.clock.runFor(2500);
  await expect(page.locator('.ahrs-calibration')).toContainText('Paused');
  await expect(progress).toHaveAttribute('value', before!);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('test-ahrs-pause-motion', { detail: false })));
  await page.clock.runFor(3000);
  await expect(page.locator('.ahrs-calibration')).not.toContainText('Paused');
  expect(Number(await progress.getAttribute('value'))).toBeGreaterThan(.65);
  await expect(page.getByRole('button', { name: 'Recalibrate', exact: true })).toHaveCount(0);
  await page.clock.runFor(3200);
  await expect(page.getByRole('button', { name: 'Recalibrate', exact: true })).toBeVisible();
  await expect(page.getByTestId('ahrs-moving-horizon')).toBeVisible();
  await expect(page.getByTestId('ahrs-cross')).toHaveText('No GPS');
  expect(await countWatches(page)).toBe(1);
});

for (const viewport of [{ width: 390, height: 844 }, { width: 744, height: 1133 }])
test(`scrolling to the attitude indicator survives paused and batched motion delivery (${viewport.width}px)`, async ({ page }) => {
  await page.setViewportSize(viewport);
  await page.clock.install();
  await openAhrs(page);
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-gps-lost')));
  await page.getByRole('button', { name: 'Calibrate', exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-sensors')));
  await page.clock.runFor(12_000);
  const content = page.locator('.map-edge-ahrs .map-edge-content');
  const horizon = page.getByTestId('ahrs-moving-horizon');
  const node = await horizon.elementHandle();
  for (const mode of ['paused', 'queued'] as const) {
    await content.evaluate(element => { element.scrollTop = element.scrollHeight; });
    expect(await content.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    await page.evaluate(mode => window.dispatchEvent(mode === 'paused'
      ? new CustomEvent('test-ahrs-pause-motion', { detail: true }) : new Event('test-ahrs-queue-motion')), mode);
    // The last sensor reading may precede its animation frame. Display it before
    // checking that the paused pose remains unchanged.
    await page.clock.runFor(100);
    const before = await horizon.getAttribute('transform');
    await content.evaluate(element => { element.scrollTop = 0; });
    await page.clock.runFor(800);
    await expect(page.getByTestId('ahrs-cross')).toHaveText('Motion');
    await expect(horizon).toHaveAttribute('transform', before!);
    await expect(page.locator('.ahrs-setup')).toHaveCount(0);
    await page.evaluate(mode => {
      window.dispatchEvent(mode === 'paused'
        ? new CustomEvent('test-ahrs-pause-motion', { detail: false }) : new Event('test-ahrs-deliver-motion'));
      window.dispatchEvent(new Event('test-ahrs-roll'));
    }, mode);
    await page.clock.runFor(500);
    await expect(horizon).toBeVisible();
    expect(await horizon.evaluate((element, original) => element === original, node)).toBe(true);
    await expect(horizon).not.toHaveAttribute('transform', before!);
    await expect(page.getByTestId('ahrs-cross')).toHaveText('No GPS');
    await expect(page.locator('.ahrs-setup')).toHaveCount(0);
    expect(await countWatches(page)).toBe(1);
    await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-steady')));
  }
});

test('rejected calibration shows its sensor check instead of 10/10 and recovers with stationary noise', async ({ page }, testInfo) => {
  await page.clock.install();
  await openAhrs(page);
  await page.getByRole('button', { name: 'Calibrate', exact: true }).click();
  await page.evaluate(() => {
    window.dispatchEvent(new Event('test-ahrs-gps-lost'));
    window.dispatchEvent(new Event('test-ahrs-roll'));
    window.dispatchEvent(new Event('test-ahrs-sensors'));
  });
  await page.clock.runFor(12_000);
  const calibration = page.locator('.ahrs-calibration');
  await expect(calibration).toContainText('Waiting');
  await expect(calibration).not.toContainText('10 / 10 s');
  await expect(calibration).toContainText('Gyro average is too high: 10.00°/s (limit 1.00°/s)');
  await expect(page.getByRole('progressbar', { name: 'Calibration progress' })).toHaveAttribute('value', '0');
  await expect(page.getByTestId('ahrs-moving-horizon')).toHaveCount(0);
  await page.setViewportSize({ width: 320, height: 568 });
  await calibration.screenshot({ path: testInfo.outputPath('ahrs-calibration-waiting.png') });
  expect(await calibration.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.evaluate(() => {
    window.dispatchEvent(new Event('test-ahrs-steady'));
    window.dispatchEvent(new Event('test-ahrs-noise'));
  });
  await page.clock.runFor(11_000);
  await expect(page.getByRole('button', { name: 'Recalibrate', exact: true })).toBeVisible();
  await expect(calibration).toHaveCount(0);
  await expect(page.getByTestId('ahrs-moving-horizon')).toBeVisible();
  await expect(page.getByTestId('ahrs-cross')).toHaveText('No GPS');
});

test('level-flight vibration calibrates without GPS and the crossed HSI keeps moving in compact and full screen', async ({ page }, testInfo) => {
  await page.clock.install();
  await openAhrs(page);
  const route = page.getByRole('textbox', { name: 'Add route waypoint', exact: true });
  await route.fill('370000N1230000W 370000N1210000W');
  await route.press('Enter');
  await page.evaluate(() => {
    window.dispatchEvent(new Event('test-ahrs-gps-lost'));
    window.dispatchEvent(new CustomEvent('test-ahrs-vibration', { detail: true }));
  });
  await page.getByRole('button', { name: 'Calibrate', exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-sensors')));
  await page.clock.runFor(12_000);
  await expect(page.getByRole('button', { name: 'Recalibrate', exact: true })).toBeVisible();
  const hsi = page.getByRole('region', { name: 'Horizontal situation indicator', exact: true });
  const compass = hsi.getByTestId('hsi-compass');
  const node = await compass.elementHandle();
  await expect(hsi.locator('.ahrs-hsi-readout')).toHaveText(/^REL \d{3}°$/);
  await expect(hsi.getByTestId('hsi-invalid')).toHaveText('No GPS');
  await expect(hsi.getByTestId('hsi-course')).toHaveCount(0);
  const before = await compass.getAttribute('transform');
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('test-ahrs-vibration', { detail: false }));
    window.dispatchEvent(new Event('test-ahrs-yaw'));
  });
  await page.clock.runFor(1000);
  await expect(compass).not.toHaveAttribute('transform', before!);
  await page.setViewportSize({ width: 393, height: 852 });
  await hsi.screenshot({ path: testInfo.outputPath('hsi-no-gps-relative.png') });
  expect(await hsi.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.getByRole('button', { name: 'Enter full screen', exact: true }).click();
  expect(await compass.evaluate((element, previous) => element === previous, node)).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-steady')));
  await page.clock.runFor(25_000);
  expect(Number.parseFloat((await page.getByTitle('Estimated tilt uncertainty (1σ)', { exact: true }).textContent())!)).toBeLessThan(10);
  await expect(hsi.locator('.ahrs-hsi-readout')).toHaveText(/^REL \d{3}°$/);
  await expect(hsi.getByTestId('hsi-invalid')).toHaveText('No GPS');
  const uncertain = await compass.getAttribute('transform');
  await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-yaw')));
  await page.clock.runFor(500);
  await expect(compass).not.toHaveAttribute('transform', uncertain!);
  await hsi.screenshot({ path: testInfo.outputPath('hsi-no-gps-fullscreen.png') });
  await page.evaluate(() => {
    window.dispatchEvent(new Event('test-ahrs-steady'));
    window.dispatchEvent(new Event('test-ahrs-gps-restored'));
  });
  await page.clock.runFor(1100);
  await expect(hsi.locator('.ahrs-hsi-readout')).toHaveText(/^HDG \d{3}° [MT]$/);
  await expect(hsi.getByTestId('hsi-course')).toBeVisible();
  await expect(hsi.getByTestId('hsi-track')).toBeVisible();
  await expect(hsi.getByTestId('hsi-invalid')).toHaveText('Heading');
  await page.evaluate(() => {
    window.dispatchEvent(new Event('test-ahrs-gps-lost'));
    window.dispatchEvent(new Event('test-ahrs-yaw'));
  });
  await page.clock.runFor(3200);
  await expect(hsi.getByTestId('hsi-invalid')).toHaveText('No GPS');
  await expect(hsi.locator('.ahrs-hsi-readout')).toHaveText(/^HDG \d{3}° [MT]$/);
  await expect(hsi.getByTestId('hsi-course')).toHaveCount(0);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(hsi.locator('.ahrs-hsi-readout')).toHaveText('HDG — M');
});

for (const mode of ['unavailable at calibration', 'lost after calibration'] as const) {
  test(`attitude stays visible and moving after prolonged GPS ${mode}`, async ({ page }, testInfo) => {
    // More than 90 simulated seconds of 50 Hz input and rendering. The virtual
    // timing/uncertainty limits stay fixed; allow slower browser test hosts.
    test.setTimeout(120_000);
    await page.clock.install();
    await openAhrs(page);
    if (mode === 'unavailable at calibration') {
      await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-gps-lost')));
    }
    await page.getByRole('button', { name: 'Calibrate', exact: true }).click();
    await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-sensors')));
    await page.clock.runFor(12_000);
    await expect(page.getByTestId('ahrs-moving-horizon')).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-gps-lost')));
    await page.clock.runFor(60_000);
    const uncertainty = page.getByTitle('Estimated tilt uncertainty (1σ)', { exact: true });
    expect(Number.parseFloat((await uncertainty.textContent())!)).toBeLessThan(6);
    await expect(page.getByTestId('ahrs-cross')).toHaveText('No GPS');
    await expect(page.locator('.ahrs-actions')).toContainText('gravity aiding active');
    await page.locator('.ahrs-diagnostics summary').click();
    await expect(page.locator('.ahrs-aiding-status')).toHaveText('Gravity / acceleration aiding');
    await expect(page.locator('.ahrs-aiding-status')).toHaveClass(/is-aided/);
    const horizon = page.getByTestId('ahrs-moving-horizon');
    await expect(horizon).toBeVisible();
    const before = await horizon.getAttribute('transform');
    await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-roll')));
    await page.clock.runFor(1000);
    await expect(horizon).not.toHaveAttribute('transform', before!);
    await expect(page.getByTestId('ahrs-cross')).toHaveText('No GPS');
    await page.locator('.ahrs-instrument').screenshot({ path: testInfo.outputPath('ahrs-prolonged-no-gps.png') });

    await page.evaluate(() => {
      window.dispatchEvent(new Event('test-ahrs-steady'));
      window.dispatchEvent(new Event('test-ahrs-gps-restored'));
    });
    await page.clock.runFor(1100);
    await expect(page.getByTestId('ahrs-cross')).toHaveCount(0);
    await expect(horizon).toBeVisible();
    await expect(page.getByRole('button', { name: 'Recalibrate', exact: true })).toBeVisible();
    await page.clock.runFor(25_000);
    await expect(page.getByTestId('ahrs-cross')).toHaveCount(0);
    await expect(horizon).toBeVisible();
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(horizon).toHaveCount(0);
    expect(await countWatches(page)).toBe(0);
  });
}

test('confirmed calibration shares GPS, keeps attitude visible under GPS-loss X, and stops cleanly', async ({ page }, testInfo) => {
  await page.clock.install();
  await openAhrs(page);
  expect(await countWatches(page)).toBe(0);
  await expect.poll(async () => (await page.locator('.map-edge-ahrs').boundingBox())!.x).toBe(0);
  await page.screenshot({ path: testInfo.outputPath('ahrs-setup.png') });
  await page.getByRole('button', { name: 'Calibrate', exact: true }).click();
  expect(await countWatches(page)).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-sensors')));
  await page.clock.runFor(12_000);
  await expect(page.locator('.ahrs-actions')).toContainText('gravity aiding active');
  await expect(page.getByTestId('ahrs-cross')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('ahrs-calibrated.png') });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('test-ahrs-speed', { detail: 5 })));
  await page.clock.runFor(1100);
  await expect(page.getByTestId('ahrs-cross')).toHaveText('Low Speed');
  await expect(page.getByTestId('hsi-invalid')).toContainText('Low Speed');
  await expect(page.locator('.ahrs-gps')).toHaveText('GPS · low speed');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('test-ahrs-speed', { detail: 60 })));
  await page.clock.runFor(1100);
  await expect(page.getByTestId('ahrs-cross')).toHaveCount(0);
  // Background explicitly preserves calibration and the single GPS subscription.
  await backgroundAhrs(page);
  expect(await countWatches(page)).toBe(1);
  await page.getByRole('button', { name: 'Show AHRS toolbox', exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-gps-lost')));
  await page.clock.runFor(3200);
  await expect(page.getByTestId('ahrs-cross')).toBeVisible();
  await expect(page.getByTestId('ahrs-cross')).toHaveText('No GPS');
  const before = await page.getByTestId('ahrs-moving-horizon').getAttribute('transform');
  await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-roll')));
  await page.clock.runFor(1200);
  expect(await page.getByTestId('ahrs-moving-horizon').getAttribute('transform')).not.toBe(before);
  await expect(page.getByRole('img', { name: /Attitude indicator/ })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('ahrs-gps-lost.png') });
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  expect(await countWatches(page)).toBe(0);
  await expect(page.getByRole('button', { name: 'Calibrate', exact: true })).toBeVisible();
});

test('Background freezes the AHRS display while calibration and motion processing continue', async ({ page }) => {
  await page.clock.install();
  await openAhrs(page);
  await page.getByRole('button', { name: 'Calibrate', exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-sensors')));
  await page.clock.runFor(2000);
  await backgroundAhrs(page);
  await page.clock.runFor(100);
  const tool = page.locator('.ahrs-tool');
  const calibrating = await tool.innerHTML();
  await page.clock.runFor(10_000);
  expect(await tool.innerHTML()).toBe(calibrating);
  expect(await countWatches(page)).toBe(1);
  await page.getByRole('button', { name: 'Show AHRS toolbox', exact: true }).click();
  await expect(page.locator('.ahrs-actions')).toContainText('gravity aiding active');
  await page.clock.runFor(100);
  await backgroundAhrs(page);
  await page.clock.runFor(100);
  const hidden = await tool.innerHTML();
  const horizon = page.getByTestId('ahrs-moving-horizon');
  const before = await horizon.getAttribute('transform');
  await page.evaluate(() => {
    window.dispatchEvent(new Event('test-ahrs-roll'));
    window.dispatchEvent(new CustomEvent('test-ahrs-altitude', { detail: 3200 }));
  });
  await page.clock.runFor(1200);
  await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-gps-lost')));
  await page.clock.runFor(3200);
  expect(await tool.innerHTML()).toBe(hidden);
  expect(await countWatches(page)).toBe(1);
  await page.getByRole('button', { name: 'Show AHRS toolbox', exact: true }).click();
  await page.clock.runFor(100);
  await expect(horizon).not.toHaveAttribute('transform', before!);
  await expect(page.getByTestId('ahrs-cross')).toHaveText('No GPS');
  await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-gps-restored')));
  await page.clock.runFor(1100);
  await expect(page.getByTestId('ahrs-cross')).toHaveCount(0);
  await expect(page.locator('.ahrs-actions')).toContainText('gravity aiding active');
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await page.clock.runFor(100);
  const stopped = await tool.innerHTML();
  await page.clock.runFor(1000);
  expect(await tool.innerHTML()).toBe(stopped);
  expect(await countWatches(page)).toBe(0);
});

test('gravity fusion bounds uncertainty under Low Speed', async ({ page }) => {
  await page.clock.install();
  await openAhrs(page);
  await page.getByRole('button', { name: 'Calibrate', exact: true }).click();
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('test-ahrs-speed', { detail: 0 }));
    window.dispatchEvent(new Event('test-ahrs-sensors'));
  });
  await page.clock.runFor(36_000);
  const diagnostics = page.locator('.ahrs-diagnostics');
  await diagnostics.locator('summary').click();
  await expect(diagnostics.locator('.ahrs-aiding-status')).toHaveText('Gravity / acceleration aiding');
  await expect(diagnostics.locator('.ahrs-aiding-status')).toHaveClass(/is-aided/);
  await expect(page.getByTestId('ahrs-cross')).toHaveText('Low Speed');
  await expect(diagnostics.locator('.ahrs-tilt-counts')).toContainText(/[1-9]\d+ used/);
  await page.clock.runFor(30_000);
  await expect(diagnostics.locator('.ahrs-tilt-counts')).toContainText(/[1-9]\d+ used/);
  expect(parseFloat(await diagnostics.locator('summary strong').innerText())).toBeLessThan(6);
  await expect(diagnostics.locator('.ahrs-uncertainty-trend path.is-aided')).not.toHaveAttribute('d', '');
  await expect(page.getByTestId('hsi-heading')).toHaveCount(0);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
});

test('gravity fusion keeps heading unverified while HSI shows GPS-assisted heading and guidance', async ({ page }, testInfo) => {
  await page.clock.install();
  await openAhrs(page);
  await page.getByRole('textbox', { name: 'Add route waypoint', exact: true }).fill('370000N1230000W 370000N1210000W');
  await page.getByRole('textbox', { name: 'Add route waypoint', exact: true }).press('Enter');
  await page.getByRole('button', { name: 'Calibrate', exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-sensors')));
  await page.clock.runFor(36_000);
  const diagnostics = page.locator('.ahrs-diagnostics');
  await diagnostics.locator('summary').click();
  await expect(diagnostics.locator('.ahrs-aiding-status')).toHaveText('Gravity / acceleration aiding');
  await expect(diagnostics.locator('.ahrs-tilt-counts')).toContainText(/[1-9]\d+ used/);
  await expect(diagnostics.locator('.ahrs-fusion-counts')).toContainText('0 used');
  await expect(page.getByTestId('hsi-heading')).toBeVisible();
  await expect(page.getByTestId('hsi-deviation')).toBeVisible();
  await expect(page.getByTestId('hsi-track')).toBeVisible();
  await expect(page.getByRole('img', { name: /^HSI\. Heading\. Estimated heading / })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 568 });
  await diagnostics.screenshot({ path: testInfo.outputPath('tilt-aiding-mobile.png') });
  expect(await diagnostics.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-gps-lost')));
  await page.clock.runFor(4000);
  await expect(diagnostics.locator('.ahrs-aiding-status')).toHaveText('Gravity / acceleration aiding');
  await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-gps-restored')));
  await page.clock.runFor(23_000);
  await expect(diagnostics.locator('.ahrs-aiding-status')).toHaveText('Gravity / acceleration aiding');
  await expect(diagnostics.locator('.ahrs-tilt-counts')).toContainText(/[1-9]\d+ used/);
  // Returning GPS does not interrupt gravity aiding while heading is unknown.
  await page.clock.runFor(12_000);
  await expect(diagnostics.locator('.ahrs-aiding-status')).toHaveText('Gravity / acceleration aiding');
  await expect(diagnostics.locator('.ahrs-tilt-counts')).toContainText(/[1-9]\d+ used/);
  await expect(page.getByTestId('hsi-invalid')).toHaveText('Heading');
  await expect(page.getByTestId('hsi-deviation')).toBeVisible();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
});

test('uncertainty diagnostics show GPS convergence, gravity during outage and GPS recovery', async ({ page }, testInfo) => {
  await page.clock.install();
  await openAhrs(page);
  const diagnostics = page.locator('.ahrs-diagnostics');
  await expect(diagnostics).toHaveCount(0);
  await page.getByText('True heading (optional)', { exact: true }).click();
  await page.getByRole('spinbutton', { name: 'True heading · degrees', exact: true }).fill('90');
  await page.getByRole('button', { name: 'Calibrate', exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-sensors')));
  await page.clock.runFor(12_000);
  await diagnostics.locator('summary').click();
  const uncertainty = diagnostics.getByTitle('Estimated tilt uncertainty (1σ)', { exact: true });
  const sigma = async () => Number.parseFloat((await uncertainty.textContent())!);
  const initial = await sigma();
  await expect(diagnostics.locator('.ahrs-aiding-status')).toHaveText('Gravity / acceleration aiding');
  await page.clock.runFor(15_000);
  const withGps = await sigma();
  expect(withGps).toBeLessThan(initial);
  const updates = diagnostics.locator('.ahrs-fusion-counts');
  await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-gps-lost')));
  await page.clock.runFor(4000);
  await expect(diagnostics.locator('.ahrs-aiding-status')).toHaveText('Gravity / acceleration aiding');
  const before = await updates.textContent();
  await page.clock.runFor(16_000);
  const withoutGps = await sigma();
  expect(withoutGps).toBeGreaterThan(0);
  expect(withoutGps).toBeLessThan(10);
  await expect(updates).toHaveText(before!);
  await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-gps-restored')));
  await page.clock.runFor(15_000);
  const recovered = await sigma();
  expect(recovered).toBeLessThan(withoutGps);
  expect(recovered).toBeLessThan(withGps + 0.2);
  await expect(diagnostics.locator('.ahrs-aiding-status')).toHaveText('Gravity / acceleration aiding');
  await expect(updates).not.toHaveText(before!);
  const trend = diagnostics.getByRole('img', { name: 'Estimated tilt uncertainty over the last two minutes' });
  await expect(trend.locator('path.is-aided')).not.toHaveAttribute('d', '');
  await expect(trend.locator('path.is-unaided')).not.toHaveAttribute('d', '');
  await testInfo.attach('tilt-uncertainty.json', {
    body: JSON.stringify({ initial, withGps, withoutGps, recovered }), contentType: 'application/json',
  });
  await page.setViewportSize({ width: 320, height: 568 });
  await diagnostics.screenshot({ path: testInfo.outputPath('ahrs-uncertainty-mobile.png') });
  expect(await diagnostics.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });
  await diagnostics.screenshot({ path: testInfo.outputPath('ahrs-uncertainty.png') });
  await page.getByRole('button', { name: 'Recalibrate', exact: true }).click();
  await page.getByRole('button', { name: 'Test', exact: true }).click();
  await expect(diagnostics).toBeHidden();
  await page.clock.runFor(100);
  const hidden = await diagnostics.innerHTML();
  await page.clock.runFor(1000);
  expect(await diagnostics.innerHTML()).toBe(hidden);
  await page.getByRole('button', { name: 'Calibrate', exact: true }).click();
  await expect(diagnostics).toHaveCount(0);
  await page.clock.runFor(12_000);
  await expect(diagnostics).not.toHaveAttribute('open');
  await diagnostics.locator('summary').click();
  // A fresh history can include an unaided segment before the first new GPS correction.
  const segments = await diagnostics.locator('.ahrs-uncertainty-trend path').evaluateAll(paths =>
    paths.reduce((sum, path) => sum + (path.getAttribute('d')?.match(/L/g)?.length ?? 0), 0));
  expect(segments).toBeLessThan(10);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(diagnostics).toHaveCount(0);
});

test('stowing AHRS confirms tab, Escape and toolbox switches, with cancel keeping AHRS open', async ({ page }, testInfo) => {
  await openAhrs(page);
  const dialog = page.getByRole('alertdialog', { name: 'Stow AHRS?', exact: true });
  const stop = dialog.getByRole('button', { name: 'Stop', exact: true });
  const keep = dialog.getByRole('button', { name: 'Cancel', exact: true });
  const confirm = dialog.getByRole('button', { name: 'Background', exact: true });
  const ahrs = page.locator('[data-edge-tab="ahrs"] .map-edge-handle');
  const gps = page.locator('[data-edge-tab="gps"] .map-edge-handle');
  await ahrs.click();
  await expect(dialog).toBeVisible();
  await expect(stop).toBeFocused();
  for (const [width, height] of [[320, 568], [568, 320]] as const) {
    await page.setViewportSize({ width, height });
    const box = (await dialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.y + box.height).toBeLessThanOrEqual(height);
    const primary = (await stop.boundingBox())!;
    const background = (await confirm.boundingBox())!;
    const cancel = (await keep.boundingBox())!;
    for (const button of [primary, background, cancel]) {
      expect(button.height).toBeGreaterThanOrEqual(44);
      expect(button.x).toBeGreaterThanOrEqual(box.x);
      expect(button.x + button.width).toBeLessThanOrEqual(box.x + box.width);
    }
    expect(primary.y + primary.height).toBeLessThanOrEqual(background.y);
    expect(primary.width).toBeGreaterThan(background.width);
    expect(background.y).toBe(cancel.y);
    await page.screenshot({ path: testInfo.outputPath(`stow-${width}.png`) });
  }
  await keep.click();
  await expect(dialog).not.toBeVisible();
  await expect(ahrs).toHaveAttribute('aria-expanded', 'true');
  await expect(ahrs).toBeFocused();
  await page.setViewportSize({ width: 1280, height: 900 });
  const mount = page.getByRole('combobox', { name: 'Device mount', exact: true });
  await mount.focus();
  await mount.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(stop).toBeFocused();
  await stop.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(ahrs).toHaveAttribute('aria-expanded', 'true');
  await expect(mount).toBeFocused();
  // An open overlay can cover another tab; keyboard activation still switches it.
  await gps.focus();
  await gps.press('Enter');
  await expect(dialog).toBeVisible();
  await keep.click();
  await expect(ahrs).toHaveAttribute('aria-expanded', 'true');
  await expect(gps).toHaveAttribute('aria-expanded', 'false');
  await gps.press('Enter');
  await confirm.click();
  await expect(ahrs).toHaveAttribute('aria-expanded', 'false');
  await expect(gps).toHaveAttribute('aria-expanded', 'true');
  await expect(gps).toBeFocused();
  await ahrs.focus();
  await ahrs.press('Enter');
  await expect(dialog).not.toBeVisible();
  await ahrs.press('Escape');
  await confirm.click();
  await expect(ahrs).toHaveAttribute('aria-expanded', 'false');
  await expect(ahrs).toBeFocused();
});

for (const { phase, duration, ownshipEnabled } of [
  { phase: 'calibrating', duration: 2000, ownshipEnabled: false },
  { phase: 'ready', duration: 12_000, ownshipEnabled: true },
] as const) {
  test(`Stop is the default stow action while ${phase} and releases only AHRS sensors`, async ({ page }) => {
    await page.clock.install();
    await openAhrs(page, 'granted', ownshipEnabled);
    await page.getByRole('button', { name: 'Calibrate', exact: true }).click();
    await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-sensors')));
    await page.clock.runFor(duration);
    if (phase === 'calibrating') await expect(page.getByRole('progressbar', { name: 'Calibration progress' })).toBeVisible();
    else await expect(page.getByRole('button', { name: 'Recalibrate', exact: true })).toBeVisible();
    expect(await countWatches(page)).toBe(1);
    const ahrs = page.locator('[data-edge-tab="ahrs"] .map-edge-handle');
    // Also cover Stop when switching directly to another toolbox.
    const target = ownshipEnabled ? page.locator('[data-edge-tab="gps"] .map-edge-handle') : ahrs;
    await target.focus();
    await target.press('Enter');
    const dialog = page.getByRole('alertdialog', { name: 'Stow AHRS?', exact: true });
    await expect(dialog.getByRole('button', { name: 'Stop', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog).not.toBeVisible();
    await page.clock.runFor(100);
    await expect(ahrs).toHaveAttribute('aria-expanded', 'false');
    await expect(target).toBeFocused();
    if (ownshipEnabled) await expect(target).toHaveAttribute('aria-expanded', 'true');
    expect(await countWatches(page)).toBe(ownshipEnabled ? 1 : 0);

    // Delivered events cannot complete the old calibration or revive attitude.
    await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-roll')));
    await page.clock.runFor(12_000);
    await ahrs.focus();
    await ahrs.press('Enter');
    await page.clock.runFor(100);
    await expect(page.getByRole('button', { name: 'Calibrate', exact: true })).toBeVisible();
    await expect(page.getByTestId('ahrs-moving-horizon')).toHaveCount(0);
    expect(await countWatches(page)).toBe(ownshipEnabled ? 1 : 0);
    await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-steady')));
    await page.getByRole('button', { name: 'Calibrate', exact: true }).click();
    await page.clock.runFor(12_000);
    await expect(page.getByRole('button', { name: 'Recalibrate', exact: true })).toBeVisible();
    expect(await countWatches(page)).toBe(1);
  });
}

test('calibration and live attitude continue while the stow confirmation awaits a decision', async ({ page }) => {
  await page.clock.install();
  await openAhrs(page);
  await page.getByRole('button', { name: 'Calibrate', exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-sensors')));
  await page.clock.runFor(2000);
  await page.getByRole('button', { name: 'Hide AHRS toolbox', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Stow AHRS?', exact: true });
  await expect(dialog).toBeVisible();
  await page.clock.runFor(10_000);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('.ahrs-actions')).toContainText('gravity aiding active');
  expect(await countWatches(page)).toBe(1);
  const horizon = page.getByTestId('ahrs-moving-horizon');
  const before = await horizon.getAttribute('transform');
  await page.getByRole('button', { name: 'Hide AHRS toolbox', exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-roll')));
  await page.clock.runFor(1000);
  expect(await horizon.getAttribute('transform')).not.toBe(before);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByTestId('ahrs-cross')).toHaveCount(0);
  await expect(page.locator('.ahrs-actions')).toContainText('gravity aiding active');
});

test('page visibility pauses instruments and automatically resumes the calibrated session', async ({ page }) => {
  await page.clock.install();
  await openAhrs(page);
  await page.getByRole('button', { name: 'Calibrate', exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-sensors')));
  await page.clock.runFor(12_000);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.runFor(100);
  const tool = page.locator('.ahrs-tool');
  const hidden = await tool.innerHTML();
  await page.clock.runFor(1500);
  expect(await tool.innerHTML()).toBe(hidden);
  expect(await countWatches(page)).toBe(0); // The shared GPS source suspends its watch in the background.
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('test-ahrs-pause-motion', { detail: true }));
    Reflect.deleteProperty(document, 'hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    // A resumed GPS watch does not replay a fix. Supply one before checking
    // motion uncertainty instead of racing the stream's next one-second tick.
    window.dispatchEvent(new CustomEvent('test-gps-position', { detail: { altitude: 3048, altitudeAccuracy: 10 } }));
    // The first returning reading ages the missing interval; subsequent
    // readings can then correct tilt through gravity fusion.
    window.dispatchEvent(new DeviceMotionEvent('devicemotion', {
      rotationRate: { alpha: 0, beta: 0, gamma: 0 },
      accelerationIncludingGravity: { x: 0, y: 9.80665, z: 0 }, interval: 20,
    }));
  });
  await page.clock.runFor(100);
  await expect(page.getByTestId('ahrs-cross')).toHaveText('Uncertainty');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('test-ahrs-pause-motion', { detail: false })));
  await page.clock.runFor(1000);
  await expect(page.getByRole('button', { name: 'Recalibrate', exact: true })).toBeVisible();
  await expect(page.locator('.ahrs-setup')).toHaveCount(0);
  await expect(page.locator('.ahrs-diagnostics')).toHaveCount(1);
  await expect(page.getByTestId('ahrs-cross')).toHaveCount(0);
  await expect(page.locator('.ahrs-actions')).toContainText('gravity aiding active');
  await expect(page.getByRole('img', { name: 'Ground speed: 120 knots', exact: true })).toBeVisible();
  const horizon = page.getByTestId('ahrs-moving-horizon');
  await expect(horizon).toBeVisible();
  const before = await horizon.getAttribute('transform');
  await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-roll')));
  await page.clock.runFor(500);
  await expect(horizon).not.toHaveAttribute('transform', before!);
  expect(await countWatches(page)).toBe(1);
});

test('incomplete and mistimed readings recover without stopping the live session', async ({ page }) => {
  await page.clock.install();
  await openAhrs(page);
  await page.getByRole('button', { name: 'Calibrate', exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-sensors')));
  await page.clock.runFor(12_000);
  for (const kind of ['incomplete', 'future', 'reversed'] as const) {
    await page.evaluate(kind => {
      const event = new DeviceMotionEvent('devicemotion', kind === 'incomplete' ? {} : {
        rotationRate: { alpha: 0, beta: 0, gamma: 0 }, accelerationIncludingGravity: { x: 0, y: 9.80665, z: 0 },
      });
      if (kind !== 'incomplete') Object.defineProperty(event, 'timeStamp', {
        value: performance.now() + (kind === 'future' ? 1000 : -1000),
      });
      window.dispatchEvent(event);
    }, kind);
    await page.clock.runFor(200);
    await expect(page.getByRole('button', { name: 'Recalibrate', exact: true })).toBeVisible();
    await expect(page.getByTestId('ahrs-moving-horizon')).toBeVisible();
    await expect(page.getByTestId('ahrs-cross')).toHaveCount(0);
    expect(await countWatches(page)).toBe(1);
  }
});

test('stop clears GPS displays while the map keeps its location watch', async ({ page }) => {
  await page.clock.install();
  await openAhrs(page, 'granted', true);
  await page.getByRole('button', { name: 'Calibrate', exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-sensors')));
  await page.clock.runFor(12_000);
  const speed = page.getByRole('img', { name: /^Ground speed:/ });
  const altitude = page.getByRole('img', { name: /^GPS altitude:/ });
  await expect(speed).toHaveAttribute('aria-label', 'Ground speed: 120 knots');
  await expect(altitude).toHaveAttribute('aria-label', 'GPS altitude: 10000 feet');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  const cleared = async () => {
    await expect(speed).toHaveAttribute('aria-label', 'Ground speed: unavailable');
    await expect(altitude).toHaveAttribute('aria-label', 'GPS altitude: unavailable');
    await expect(page.getByRole('img', { name: /^GPS vertical speed:/ })).toHaveAttribute('aria-label', 'GPS vertical speed: unavailable');
    await expect(page.locator('.ahrs-gps')).toHaveText('No GPS');
    await expect(page.getByTestId('hsi-track')).toHaveCount(0);
    await expect(page.getByTestId('hsi-invalid')).toHaveText('No GPS');
  };
  await cleared();
  expect(await countWatches(page), 'the map still owns GPS').toBe(1);
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('test-ahrs-speed', { detail: 20 }));
    window.dispatchEvent(new CustomEvent('test-ahrs-altitude', { detail: 4000 }));
  });
  await page.clock.runFor(5000);
  await cleared();
  await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-gps-lost')));
  await page.clock.runFor(15_000);
  await cleared();
});

test('AHRS is a tool without a right-panel layer toggle', async ({ page }) => {
  await openAhrs(page);
  await expect(page.getByRole('checkbox', { name: /AHRS|Attitude/i })).toHaveCount(0);
  await expect(page.getByRole('switch', { name: /AHRS|Attitude/i })).toHaveCount(0);
  await backgroundAhrs(page);
  await expect(page.getByRole('region', { name: 'AHRS toolbox', exact: true })).toBeHidden();
  expect(await countWatches(page)).toBe(0);
});

test('mechanical GS and GPS altitude animate between fixes, show mph, and clear lost readings', async ({ page }, testInfo) => {
  await page.clock.install();
  await openAhrs(page);
  const speed = page.getByRole('img', { name: /^Ground speed:/ });
  const altitude = page.getByRole('img', { name: /^GPS altitude:/ });
  const vsi = page.getByRole('img', { name: /^GPS vertical speed:/ });
  await expect(speed).toHaveAttribute('aria-label', 'Ground speed: unavailable');
  await expect(altitude).toHaveAttribute('aria-label', 'GPS altitude: unavailable');
  await expect(vsi).toHaveAttribute('aria-label', 'GPS vertical speed: unavailable');
  await page.getByRole('button', { name: 'Calibrate', exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-sensors')));
  await page.clock.runFor(12_000);
  await expect(speed).toHaveAttribute('aria-label', 'Ground speed: 120 knots');
  await expect(page.locator('.ahrs-speed-mph')).toHaveText('138 mph');
  await expect(altitude).toHaveAttribute('aria-label', 'GPS altitude: 10000 feet');
  await expect(vsi).toHaveAttribute('aria-label', 'GPS vertical speed: 0 feet per minute');
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('test-ahrs-speed', { detail: 122 * 1852 / 3600 }));
    window.dispatchEvent(new CustomEvent('test-ahrs-altitude', { detail: 10040 * .3048 }));
  });
  await page.clock.runFor(1100);
  const first = Number((await altitude.getAttribute('aria-label'))!.match(/-?\d+/)![0]);
  const firstDrum = await altitude.locator('g[transform]').first().getAttribute('transform');
  await page.clock.runFor(150); // No new one-second GPS sample during this interval.
  const next = Number((await altitude.getAttribute('aria-label'))!.match(/-?\d+/)![0]);
  expect(first).toBeGreaterThan(10000);
  expect(first).toBeLessThan(10040);
  expect(next).toBeGreaterThan(first);
  await expect(altitude.locator('g[transform]').first()).not.toHaveAttribute('transform', firstDrum!);
  expect(await countWatches(page)).toBe(1);
  for (const [width, height] of [[1280, 900], [393, 852], [320, 568], [568, 320]] as const) {
    await page.setViewportSize({ width, height });
    await page.locator('.ahrs-instrument').scrollIntoViewIfNeeded();
    await expect(speed).toBeVisible();
    await expect(altitude).toBeVisible();
    await expect(vsi).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`drums-${width}.png`) });
  }
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('test-ahrs-altitude', { detail: null })));
  await page.clock.runFor(1100);
  await expect(altitude).toHaveAttribute('aria-label', 'GPS altitude: unavailable');
  await expect(vsi).toHaveAttribute('aria-label', 'GPS vertical speed: unavailable');
  await expect(speed).not.toHaveAttribute('aria-label', 'Ground speed: unavailable');
  await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-gps-lost')));
  await page.clock.runFor(3200);
  await expect(speed).toHaveAttribute('aria-label', 'Ground speed: unavailable');
  await expect(page.locator('.ahrs-speed-mph')).toHaveText('— mph');
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('test-ahrs-altitude', { detail: -120 * .3048 }));
    window.dispatchEvent(new CustomEvent('test-ahrs-speed', { detail: 0 }));
    window.dispatchEvent(new Event('test-ahrs-gps-restored'));
  });
  await page.clock.runFor(1100);
  await expect(altitude).toHaveAttribute('aria-label', 'GPS altitude: -120 feet');
  await expect(vsi).toHaveAttribute('aria-label', 'GPS vertical speed: unavailable');
  await expect(speed).toHaveAttribute('aria-label', 'Ground speed: 0 knots');
  await expect(page.locator('.ahrs-speed-mph')).toHaveText('0 mph');
  await expect(page.getByTestId('ahrs-cross')).toHaveText('Low Speed');
});

test('denied motion permission explains how to retry without starting GPS', async ({ page }) => {
  await openAhrs(page, 'denied');
  await page.getByRole('button', { name: 'Calibrate', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Allow Motion & Orientation');
  await expect(page.getByTestId('ahrs-cross')).toHaveText('Calibration');
  await expect(page.getByTestId('ahrs-moving-horizon')).toHaveCount(0);
  expect(await countWatches(page)).toBe(0);
});

test('HSI seeds geographic heading from GPS and carries it with gyro motion between fixes', async ({ page }, testInfo) => {
  await page.clock.install({ time: new Date('2026-09-18T12:00:00Z') });
  await openAhrs(page);
  const route = page.getByRole('textbox', { name: 'Add route waypoint', exact: true });
  await route.fill('370000N1230000W 370000N1210000W 380000N1210000W');
  await route.press('Enter');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('test-ahrs-speed', { detail: 0 })));
  await page.getByRole('button', { name: 'Calibrate', exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-sensors')));
  await page.clock.runFor(12_000);
  const hsi = page.getByRole('region', { name: 'Horizontal situation indicator', exact: true });
  await expect(hsi.locator('.ahrs-hsi-readout')).toHaveText('REL 000°');
  await expect(hsi.getByRole('img')).toHaveAttribute('aria-label', /Low Speed\. Relative direction 000°\. Heading unverified/);
  await expect(hsi.getByTestId('hsi-invalid')).toContainText('Low Speed');
  await expect(hsi.getByTestId('hsi-course')).toHaveCount(0);
  await expect(hsi.getByTestId('hsi-deviation')).toHaveCount(0);
  await expect(hsi.getByTestId('hsi-relative-heading')).toBeVisible();
  await expect(hsi.getByTestId('hsi-heading')).toHaveCount(0);
  await expect(hsi.getByTestId('hsi-track')).toHaveCount(0);
  const compass = await hsi.getByTestId('hsi-compass').getAttribute('transform');
  await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-yaw')));
  await page.clock.runFor(1000);
  await expect(hsi.getByTestId('hsi-compass')).not.toHaveAttribute('transform', compass!);
  await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-steady')));
  await hsi.screenshot({ path: testInfo.outputPath('hsi-stationary-relative.png') });
  await page.getByRole('combobox', { name: 'HSI route leg' }).selectOption({ index: 2 });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('test-ahrs-speed', { detail: 5 })));
  await page.clock.runFor(1100);
  await expect(hsi.locator('.ahrs-hsi-readout')).toHaveText(/^REL /);
  await expect(hsi.getByTestId('hsi-invalid')).toContainText('Low Speed');
  await expect(hsi.getByTestId('hsi-course')).toHaveCount(0);
  await expect(hsi.getByTestId('hsi-track')).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('test-ahrs-speed', { detail: 120 * 1852 / 3600 })));
  await page.clock.runFor(1100);
  await expect(hsi.locator('.ahrs-hsi-readout')).toHaveText(/^HDG /);
  await expect(hsi.getByTestId('hsi-invalid')).toContainText('Heading');
  await expect(hsi.getByTestId('hsi-course')).toBeVisible();
  const movingCompass = await hsi.getByTestId('hsi-compass').getAttribute('transform');
  await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-yaw')));
  await page.clock.runFor(100);
  await expect(hsi.getByTestId('hsi-compass')).not.toHaveAttribute('transform', movingCompass!);
  await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-gps-lost')));
  await page.clock.runFor(3200);
  await expect(hsi.getByTestId('hsi-invalid')).toContainText('No GPS');
  await expect(hsi.getByTestId('hsi-course')).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-gps-restored')));
  await page.clock.runFor(1100);
  await expect(hsi.getByTestId('hsi-course')).toBeVisible();
  await expect(hsi.getByTestId('hsi-invalid')).toContainText('Heading');
  await expect(hsi.getByTestId('hsi-relative-heading')).toHaveCount(0);
});

test('compact HSI follows the route, supports a selected leg, and flags lost GPS', async ({ page }, testInfo) => {
  await page.clock.install({ time: new Date('2026-09-18T12:00:00Z') });
  await openAhrs(page);
  const route = page.getByRole('textbox', { name: 'Add route waypoint', exact: true });
  await route.fill('370000N1230000W 370000N1210000W 380000N1210000W');
  await route.press('Enter');
  await page.getByText('True heading (optional)', { exact: true }).click();
  await page.getByRole('spinbutton', { name: 'True heading · degrees' }).fill('75');
  await page.getByRole('button', { name: 'Calibrate', exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-sensors')));
  await page.clock.runFor(12_000);
  const hsi = page.getByRole('region', { name: 'Horizontal situation indicator', exact: true });
  await expect(hsi.getByRole('img')).toHaveAttribute('aria-label', /Heading 062° magnetic\. Course 077° magnetic/);
  await expect(page.getByTestId('hsi-heading')).toBeVisible();
  await expect(hsi.locator('.ahrs-hsi-readout')).toHaveText('HDG 062° M');
  await expect(hsi.locator('.ahrs-hsi-reference')).toHaveText('TRK 077° M');
  await expect(hsi.locator('.ahrs-hsi-variation')).toHaveText(/TRUE HDG 075° T.*VAR 12.6° E/);
  await expect(page.getByTestId('hsi-true-north')).toHaveCount(0);
  await expect(page.getByTestId('hsi-track')).toHaveAttribute('transform', /rotate\(15\)/);
  await expect(page.getByTestId('hsi-invalid')).toHaveCount(0);
  expect(await countWatches(page)).toBe(1);
  const first = await page.getByTestId('hsi-deviation').getAttribute('transform');
  await page.clock.runFor(50);
  await sendFix(page, { latitude: 37.02 });
  await expect(page.getByTestId('hsi-deviation')).not.toHaveAttribute('transform', first!);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('test-ahrs-speed', { detail: 5 })));
  await page.clock.runFor(1100);
  await expect(hsi.locator('.ahrs-hsi-readout')).toHaveText('HDG 062° M');
  await expect(hsi.getByTestId('hsi-caution')).toHaveText('Low Speed');
  await expect(hsi.getByTestId('hsi-course')).toBeVisible();
  await expect(hsi.getByTestId('hsi-deviation')).toBeVisible();
  await expect(hsi.getByTestId('hsi-invalid')).toHaveCount(0);
  await hsi.screenshot({ path: testInfo.outputPath('hsi-low-speed-heading.png') });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('test-ahrs-speed', { detail: 120 * 1852 / 3600 })));
  await page.clock.runFor(1100);
  await expect(hsi.getByTestId('hsi-caution')).toHaveCount(0);
  await page.getByRole('combobox', { name: 'HSI route leg' }).selectOption({ index: 2 });
  await expect(hsi.getByRole('img')).toHaveAttribute('aria-label', /Course 347° magnetic/);
  const selectedLeg = await page.getByRole('combobox', { name: 'HSI route leg' }).inputValue();
  await backgroundAhrs(page);
  await page.clock.runFor(100);
  const frozenHsi = await page.locator('.ahrs-hsi').innerHTML();
  await route.fill('390000N1210000W');
  await route.press('Enter');
  await page.clock.runFor(1100);
  expect(await page.locator('.ahrs-hsi').innerHTML()).toBe(frozenHsi);
  await page.getByRole('button', { name: 'Show AHRS toolbox', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'HSI route leg' })).toHaveValue(selectedLeg);
  await expect(page.getByRole('combobox', { name: 'HSI route leg' }).locator('option')).toHaveCount(4);
  await page.getByRole('combobox', { name: 'HSI route leg' }).selectOption('auto');
  for (const [width, height] of [[1280, 900], [393, 852], [320, 568], [568, 320]] as const) {
    await page.setViewportSize({ width, height });
    await page.clock.runFor(100);
    await hsi.scrollIntoViewIfNeeded();
    const headingBox = (await hsi.locator('.ahrs-hsi-readout').boundingBox())!;
    const dialBox = (await hsi.locator('.ahrs-hsi-dial').boundingBox())!;
    expect(headingBox.y + headingBox.height).toBeLessThanOrEqual(dialBox.y);
    expect(Math.abs(headingBox.x + headingBox.width / 2 - dialBox.x - dialBox.width / 2)).toBeLessThan(1);
    await page.screenshot({ path: testInfo.outputPath(`hsi-${width}.png`), animations: 'disabled' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-gps-lost')));
  await page.clock.runFor(3200);
  await expect(page.getByTestId('hsi-invalid')).toContainText('No GPS');
  await expect(page.getByTestId('hsi-course')).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-gps-restored')));
  await page.clock.runFor(1100);
  await expect(page.getByTestId('hsi-course')).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: 'Route actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Clear Route', exact: true }).click();
  await expect(hsi).toContainText('Add a route');
  await expect(page.getByTestId('hsi-course')).toHaveCount(0);
});

test.describe('magnetic model recovery', () => {
  test.use({ serviceWorkers: 'block' });
  test('failed model loading shows TRUE and reconnection restores MAG without recalibration', async ({ page }) => {
    let unavailable = true, requests = 0;
    await page.route('**/nav/magnetic-model.json?*', async route => {
      requests++;
      if (unavailable) await route.fulfill({ status: 503, body: 'Temporarily unavailable' });
      else await route.continue();
    });
    await page.clock.install({ time: new Date('2026-09-18T12:00:00Z') });
    await openAhrs(page);
    await page.getByText('True heading (optional)', { exact: true }).click();
    await page.getByRole('spinbutton', { name: 'True heading · degrees' }).fill('75');
    await page.getByRole('button', { name: 'Calibrate', exact: true }).click();
    await page.evaluate(() => window.dispatchEvent(new Event('test-ahrs-sensors')));
    await page.clock.runFor(12_000);
    await expect.poll(() => requests).toBe(1);
    const hsi = page.getByRole('region', { name: 'Horizontal situation indicator', exact: true });
    await expect(hsi.locator('.ahrs-hsi-heading')).toHaveText('HSIIMU · TRUE');
    await expect(hsi.locator('.ahrs-hsi-variation')).toContainText('Magnetic variation unavailable · using TRUE');
    await expect(hsi.locator('.ahrs-hsi-readout')).toHaveText('HDG 075° T');
    unavailable = false;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(hsi.locator('.ahrs-hsi-heading')).toHaveText('HSIIMU · MAG');
    await expect(hsi.locator('.ahrs-hsi-readout')).toHaveText('HDG 062° M');
    await expect(page.locator('.ahrs-actions')).toContainText('gravity aiding active');
    expect(await countWatches(page)).toBe(1);
  });
});
