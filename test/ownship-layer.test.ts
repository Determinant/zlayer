import assert from 'node:assert/strict';
import test from 'node:test';
import { createOwnshipLayer } from '../src/layers/ownship/layer';
import { destination, GPS_STALE_MS } from '../src/layers/ownship/position';

function setup(t: test.TestContext) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_800_000_000_000 });
  const callbacks: { success: PositionCallback; error: PositionErrorCallback | null | undefined }[] = [];
  const active = new Set<number>();
  const options: (PositionOptions | undefined)[] = [];
  const visibility = Object.assign(new EventTarget(), { hidden: false });
  let secure = true, supported = true;
  const api = {
    watchPosition(success: PositionCallback, error?: PositionErrorCallback | null, configuration?: PositionOptions) {
      const id = callbacks.length;
      callbacks.push({ success, error }); active.add(id); options.push(configuration);
      return id;
    },
    clearWatch(id: number) { active.delete(id); },
  };
  const layer = createOwnshipLayer({ geolocation: () => supported ? api : undefined, secure: () => secure, visibility });
  t.after(() => layer.detach());
  const fix = (id = callbacks.length - 1, offset = 0, coords: Partial<GeolocationCoordinates> = {}) =>
    callbacks[id]!.success({ timestamp: Date.now() + offset,
      coords: { latitude: 37, longitude: -122, accuracy: 5, speed: 60, heading: 90, ...coords } } as GeolocationPosition);
  const error = (code: number, id = callbacks.length - 1) => callbacks[id]!.error?.({ code } as GeolocationPositionError);
  return { layer, active, callbacks, options, fix, error, visibility,
    setSecure: (value: boolean) => { secure = value; }, setSupported: (value: boolean) => { supported = value; } };
}

test('GPS waits for a consumer, uses a single high-accuracy watch and clears even watch ID zero', t => {
  const { layer, active, options, fix } = setup(t);
  layer.attach();
  assert.equal(active.size, 0);
  layer.setEnabled(true);
  layer.attach(); layer.setEnabled(true);
  assert.deepEqual([...active], [0]);
  assert.deepEqual(options, [{ enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }]);
  fix();
  assert.equal(layer.getSnapshot().state, 'tracking');
  assert.equal(layer.getSnapshot().centerRequest, 1);
  t.mock.timers.tick(1000); fix();
  assert.equal(layer.getSnapshot().centerRequest, 1, 'updates must not keep moving the map');
  layer.center();
  assert.equal(layer.getSnapshot().centerRequest, 2);
  layer.setEnabled(false);
  assert.equal(active.size, 0);
  assert.equal(layer.getSnapshot().fix, null);
  fix();
  assert.equal(layer.getSnapshot().state, 'off', 'late callbacks cannot resurrect a disabled layer');
});

test('expiration uses the fix timestamp, stops the projection, and recovers with a fresh fix', t => {
  const { layer, fix } = setup(t);
  layer.setEnabled(true); layer.attach(); fix(0, -2000);
  t.mock.timers.tick(GPS_STALE_MS - 2001);
  assert.equal(layer.getSnapshot().state, 'tracking');
  t.mock.timers.tick(1);
  assert.equal(layer.getSnapshot().state, 'stale');
  assert.ok(layer.getSnapshot().fix);
  fix();
  assert.equal(layer.getSnapshot().state, 'tracking');
});

test('permission denial stops the watch and retry starts cleanly; transient errors can recover', t => {
  const { layer, fix, error, active } = setup(t);
  layer.setEnabled(true); layer.attach(); error(1);
  assert.equal(layer.getSnapshot().state, 'denied');
  assert.equal(active.size, 0);
  fix(0);
  assert.equal(layer.getSnapshot().fix, null);
  layer.retry(); fix(); error(2);
  assert.equal(layer.getSnapshot().state, 'stale');
  assert.equal(active.size, 1);
  t.mock.timers.tick(1000); fix();
  assert.equal(layer.getSnapshot().state, 'tracking');
  error(3);
  assert.equal(layer.getSnapshot().state, 'stale');
});

test('hidden apps pause GPS, resume with fresh acquisition, and detach cleans listeners and timers', t => {
  const { layer, fix, active, callbacks, visibility } = setup(t);
  layer.setEnabled(true); layer.attach(); fix();
  visibility.hidden = true; visibility.dispatchEvent(new Event('visibilitychange'));
  assert.equal(active.size, 0);
  assert.equal(layer.getSnapshot().state, 'paused');
  assert.equal(layer.getSnapshot().fix, null);
  visibility.hidden = false; visibility.dispatchEvent(new Event('visibilitychange'));
  assert.equal(active.size, 1);
  assert.equal(layer.getSnapshot().state, 'acquiring');
  fix(0);
  assert.equal(layer.getSnapshot().fix, null, 'old watch callbacks are ignored after resume');
  fix();
  layer.detach(); layer.detach();
  visibility.dispatchEvent(new Event('visibilitychange'));
  t.mock.timers.tick(2 * GPS_STALE_MS);
  assert.equal(layer.getSnapshot().state, 'off');
  assert.equal(active.size, 0);
  assert.equal(callbacks.length, 2);
  layer.attach();
  assert.equal(active.size, 1, 'remount restores the enabled layer');
});

test('insecure contexts, missing APIs, and initial timeout show actionable state', t => {
  const { layer, setSecure, setSupported, active, error } = setup(t);
  setSecure(false); layer.setEnabled(true); layer.attach();
  assert.equal(layer.getSnapshot().state, 'insecure');
  setSecure(true); setSupported(false); layer.retry();
  assert.equal(layer.getSnapshot().state, 'unsupported');
  assert.equal(active.size, 0);
  setSupported(true); layer.retry(); error(3);
  assert.equal(layer.getSnapshot().state, 'unavailable');
});

test('a silent watch is replaced at fix expiry and stale fixes remain visible until recovery', t => {
  const { layer, fix, active, callbacks } = setup(t);
  layer.setEnabled(true); layer.attach(); fix();
  const previous = layer.getSnapshot().fix;
  t.mock.timers.tick(GPS_STALE_MS);
  assert.equal(layer.getSnapshot().state, 'stale');
  assert.equal(layer.getSnapshot().fix, previous);
  assert.deepEqual([...active], [1]);
  assert.equal(callbacks.length, 2, 'request a fresh acquisition even without a significant location change');
  fix(0);
  assert.equal(layer.getSnapshot().state, 'stale', 'expired watch cannot revive a fix');
  fix();
  assert.equal(layer.getSnapshot().state, 'tracking');
  assert.equal(layer.getSnapshot().centerRequest, 1, 'background recovery must not move the camera');
});

test('initial timeout or rejected fixes reacquire with bounded retries and stop when disabled', t => {
  const { layer, fix, error, active, callbacks } = setup(t);
  layer.setEnabled(true); layer.attach(); error(3);
  t.mock.timers.tick(4999);
  assert.equal(callbacks.length, 1);
  t.mock.timers.tick(1);
  assert.equal(callbacks.length, 2);
  fix(1, -60_000);
  assert.equal(layer.getSnapshot().state, 'unavailable');
  t.mock.timers.tick(5000);
  assert.equal(callbacks.length, 3);
  error(2);
  layer.setEnabled(false);
  t.mock.timers.tick(60_000);
  assert.equal(callbacks.length, 3);
  assert.equal(active.size, 0);
});

test('denied permission never starts an automatic retry', t => {
  const { layer, error, active, callbacks } = setup(t);
  layer.setEnabled(true); layer.attach(); error(1);
  t.mock.timers.tick(60_000);
  assert.equal(active.size, 0);
  assert.equal(callbacks.length, 1);
});

test('stale callbacks on a replacement watch do not prevent another acquisition attempt', t => {
  const { layer, fix, active } = setup(t);
  layer.setEnabled(true); layer.attach(); fix();
  t.mock.timers.tick(GPS_STALE_MS);
  fix(1, -GPS_STALE_MS);
  assert.equal(layer.getSnapshot().state, 'stale');
  t.mock.timers.tick(5000);
  assert.deepEqual([...active], [2]);
  fix();
  assert.equal(layer.getSnapshot().state, 'tracking');
});

test('recovery cancels a pending retry and hiding cancels all scheduled acquisition work', t => {
  const { layer, fix, error, active, callbacks, visibility } = setup(t);
  layer.setEnabled(true); layer.attach(); error(2);
  t.mock.timers.tick(1000); fix();
  t.mock.timers.tick(4000);
  assert.equal(callbacks.length, 1, 'successful watch callbacks cancel retries');
  error(3);
  visibility.hidden = true; visibility.dispatchEvent(new Event('visibilitychange'));
  t.mock.timers.tick(60_000);
  assert.equal(active.size, 0);
  assert.equal(callbacks.length, 1);
});

test('a reported stop clears the motion baseline before missing velocity resumes', t => {
  const { layer, fix } = setup(t);
  layer.setEnabled(true); layer.attach(); fix();
  t.mock.timers.tick(2000);
  const [longitude, latitude] = destination([-122, 37], 90, 120);
  fix(0, 0, { longitude, latitude, speed: 0 });
  t.mock.timers.tick(200);
  fix(0, 0, { longitude, latitude, speed: null, heading: null });
  assert.equal(layer.getSnapshot().fix!.speed, null);
  assert.equal(layer.getSnapshot().fix!.track, null);
});

test('GPS turn trends use recent tracks and reset after stopping, stale fixes and acquisition errors', t => {
  const { layer, fix, error } = setup(t);
  layer.setEnabled(true); layer.attach();
  const establishTurn = () => {
    fix(undefined, 0, { heading: 358 });
    assert.equal(layer.getSnapshot().turnRate, null);
    t.mock.timers.tick(1000); fix(undefined, 0, { heading: 359 });
    t.mock.timers.tick(1000); fix(undefined, 0, { heading: 0 });
    assert.equal(layer.getSnapshot().turnRate, 1);
    assert.deepEqual(layer.getSnapshot().fix!.coordinates, [-122, 37]);
  };
  establishTurn();
  t.mock.timers.tick(1000); fix(undefined, 0, { speed: 0 });
  assert.equal(layer.getSnapshot().turnRate, null);
  t.mock.timers.tick(1000); establishTurn();
  t.mock.timers.tick(GPS_STALE_MS);
  assert.equal(layer.getSnapshot().state, 'stale');
  assert.equal(layer.getSnapshot().turnRate, null);
  establishTurn();
  error(2);
  assert.equal(layer.getSnapshot().turnRate, null);
  t.mock.timers.tick(1000); establishTurn();
});

for (const interruption of ['missing track', 'estimated speed'] as const) {
  test(`turn history retains ${interruption} interruptions between sampled fixes`, t => {
    const { layer, fix } = setup(t);
    layer.setEnabled(true); layer.attach();
    for (let second = 0; second <= 2; second++) {
      if (second) t.mock.timers.tick(1000);
      fix(0, 0, { heading: 90 + second });
    }
    assert.equal(layer.getSnapshot().turnRate, 1);
    // This callback falls between the layer's retained 100 ms samples.
    const lastRetainedTime = Date.now();
    t.mock.timers.tick(50);
    const [longitude, latitude] = destination([-122, 37], 90, 123);
    fix(0, 0, interruption === 'missing track' ? { heading: null }
      : { longitude, latitude, heading: 92.05, speed: null });
    assert.equal(layer.getSnapshot().turnRate, null);
    assert.equal(layer.getSnapshot().fix!.estimated, interruption === 'estimated speed');
    for (const elapsed of [100, 200, 500, 1000, 1100]) {
      t.mock.timers.setTime(lastRetainedTime + elapsed);
      fix(0, 0, { heading: 92 + elapsed / 1000 });
      const rate = layer.getSnapshot().turnRate;
      if (elapsed < 1100) assert.equal(rate, null, 'wait for a new continuous one-second turn baseline');
      else assert.ok(Math.abs(rate! - 1) < 1e-9);
    }
  });
}

test('high frequency fixes estimate motion without flicker and stop estimating once stationary', t => {
  const { layer, fix } = setup(t);
  layer.setEnabled(true); layer.attach();
  for (let index = 0; index <= 20; index++) {
    if (index) t.mock.timers.tick(200);
    const [longitude, latitude] = destination([-122, 37], 90, index * 12);
    fix(0, 0, { longitude, latitude, heading: null, speed: null, accuracy: 20 });
    if (index >= 10) {
      assert.ok(Math.abs(layer.getSnapshot().fix!.speed! - 60) < .001);
      assert.ok(Math.abs(layer.getSnapshot().fix!.track! - 90) < .01);
      assert.equal(layer.getSnapshot().fix!.estimated, true);
    }
  }
  const [longitude, latitude] = layer.getSnapshot().fix!.coordinates;
  for (let index = 0; index < 15; index++) {
    t.mock.timers.tick(200);
    fix(0, 0, { longitude, latitude, heading: null, speed: null, accuracy: 20 });
  }
  assert.equal(layer.getSnapshot().fix!.track, null, 'a longer history must not keep implying movement after stopping');
  assert.equal(layer.getSnapshot().fix!.speed, null);
});

test('tools share one GPS watch without enabling or centering the map aircraft', t => {
  const { layer, fix, active, callbacks } = setup(t);
  layer.attach();
  const releaseAhrs = layer.acquire(), releaseOther = layer.acquire();
  assert.equal(active.size, 1);
  fix();
  assert.equal(layer.getSnapshot().enabled, false);
  assert.equal(layer.getSnapshot().centerRequest, 0);
  layer.setEnabled(true);
  assert.equal(callbacks.length, 1, 'enabling the map reuses the running watch');
  t.mock.timers.tick(1000); fix();
  assert.equal(layer.getSnapshot().centerRequest, 1);
  layer.setEnabled(false); layer.detach();
  assert.equal(active.size, 1, 'tool leases survive map toggle and detachment');
  releaseAhrs(); releaseAhrs();
  assert.equal(active.size, 1, 'releasing a lease is idempotent');
  releaseOther();
  assert.equal(active.size, 0);
  assert.equal(layer.getSnapshot().state, 'off');
});

test('a GPS lease observes background pauses without a map attachment', t => {
  const { layer, fix, active, visibility } = setup(t);
  const release = layer.acquire();
  fix();
  visibility.hidden = true; visibility.dispatchEvent(new Event('visibilitychange'));
  assert.equal(active.size, 0);
  assert.equal(layer.getSnapshot().state, 'paused');
  visibility.hidden = false; visibility.dispatchEvent(new Event('visibilitychange'));
  assert.equal(active.size, 1);
  release();
  visibility.dispatchEvent(new Event('visibilitychange'));
  assert.equal(active.size, 0);
});
