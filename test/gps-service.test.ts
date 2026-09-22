import assert from 'node:assert/strict';
import test from 'node:test';
import { createGpsService } from '../src/core/gps/service';
import { createOwnshipLayer } from '../src/layers/ownship/layer';
import { createAhrsLayer } from '../src/layers/ahrs/layer';
import type { ImuSample } from '../src/layers/ahrs/estimator/types';
import { G, RAD } from '../src/layers/ahrs/estimator/math';

function setup(t: test.TestContext) {
  const origin = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: origin });
  const active = new Set<number>();
  const callbacks: { success: PositionCallback; error: PositionErrorCallback | null | undefined }[] = [];
  const visibility = Object.assign(new EventTarget(), { hidden: false });
  const gps = createGpsService({ secure: () => true, visibility, geolocation: () => ({
    watchPosition(success, error) {
      const id = callbacks.length;
      callbacks.push({ success, error }); active.add(id);
      return id;
    },
    clearWatch(id) { active.delete(id); },
  }) });
  const fix = (id = callbacks.length - 1) => callbacks[id]!.success({ timestamp: Date.now(),
    coords: { latitude: 37, longitude: -122, accuracy: 5, speed: 55, heading: 75, altitude: 3048, altitudeAccuracy: 10 },
  } as GeolocationPosition);
  return { gps, active, callbacks, visibility, fix, origin, now: () => (Date.now() - origin) / 1000 };
}

test('core GPS is passive until leased and shares one watch across independently released consumers', t => {
  const s = setup(t);
  const unsubscribe = s.gps.subscribe(() => {});
  t.after(unsubscribe);
  assert.equal(s.active.size, 0);
  const first = s.gps.acquire(), second = s.gps.acquire();
  t.after(first); t.after(second);
  assert.deepEqual([...s.active], [0]);
  s.fix();
  assert.equal(s.gps.getSnapshot().state, 'tracking');
  first(); first();
  assert.equal(s.active.size, 1);
  const third = s.gps.acquire();
  t.after(third);
  assert.equal(s.callbacks.length, 1, 'another consumer does not replace an existing watch');
  second(); third();
  assert.equal(s.active.size, 0);
  assert.equal(s.gps.getSnapshot().state, 'off');
  s.fix(0);
  assert.equal(s.gps.getSnapshot().fix, null, 'late callbacks cannot revive the released source');
  s.visibility.dispatchEvent(new Event('visibilitychange'));
  t.mock.timers.tick(60_000);
  assert.equal(s.callbacks.length, 1, 'last release removes visibility demand and timers');
});

test('background pauses, permission denial and retries affect one shared source without changing leases', t => {
  const s = setup(t), first = s.gps.acquire(), second = s.gps.acquire();
  t.after(first); t.after(second);
  s.fix();
  s.visibility.hidden = true; s.visibility.dispatchEvent(new Event('visibilitychange'));
  assert.equal(s.active.size, 0);
  assert.equal(s.gps.getSnapshot().state, 'paused');
  first();
  s.visibility.hidden = false; s.visibility.dispatchEvent(new Event('visibilitychange'));
  assert.equal(s.active.size, 1, 'the remaining consumer restarts exactly one watch');
  s.callbacks.at(-1)!.error?.({ code: 1 } as GeolocationPositionError);
  assert.equal(s.active.size, 0);
  assert.equal(s.gps.getSnapshot().state, 'denied');
  t.mock.timers.tick(60_000);
  assert.equal(s.callbacks.length, 2, 'permission denial does not automatically retry');
  s.gps.retry(); s.fix();
  assert.equal(s.gps.getSnapshot().state, 'tracking');
  assert.equal(s.active.size, 1);
  second();
  assert.equal(s.active.size, 0);
});

test('releasing during restart notification prevents another browser location request', t => {
  const s = setup(t), release = s.gps.acquire();
  t.after(release);
  t.after(s.gps.subscribe(() => {
    if (s.gps.getSnapshot().state === 'acquiring') release();
  }));
  s.gps.retry();
  assert.equal(s.gps.getSnapshot().state, 'off');
  assert.equal(s.active.size, 0);
  assert.equal(s.callbacks.length, 1, 'a cancelled restart must not call watchPosition');
});

test('replacing a session during an error notification preserves retries for the new consumer', t => {
  const s = setup(t);
  let release = s.gps.acquire(), replaced = false;
  t.after(() => release());
  t.after(s.gps.subscribe(() => {
    if (replaced || s.gps.getSnapshot().state !== 'unavailable') return;
    replaced = true;
    release();
    release = s.gps.acquire();
  }));
  s.callbacks[0]!.error?.({ code: 2 } as GeolocationPositionError);
  assert.deepEqual([...s.active], [1]);
  s.callbacks[1]!.error?.({ code: 2 } as GeolocationPositionError);
  t.mock.timers.tick(5000);
  assert.equal(s.callbacks.length, 3, 'the old error cannot suppress the new session’s retry');
  assert.deepEqual([...s.active], [2]);
  s.fix();
  assert.equal(s.gps.getSnapshot().state, 'tracking');
});

test('AHRS stopped during GPS acquisition releases the newly acquired lease', async t => {
  const s = setup(t);
  const ahrs = createAhrsLayer(s.gps, { now: s.now, timeOrigin: s.origin,
    motion: () => ({ start: async () => {}, stop() {} }),
  });
  t.after(ahrs.stop);
  t.after(s.gps.subscribe(() => {
    if (s.gps.getSnapshot().state === 'acquiring') ahrs.stop();
  }));
  await ahrs.calibrate();
  assert.equal(ahrs.getSnapshot().phase, 'idle');
  assert.equal(s.gps.getSnapshot().state, 'off');
  assert.equal(s.active.size, 0);
  const stopped = ahrs.getSnapshot();
  t.mock.timers.tick(60_000);
  s.fix();
  assert.equal(ahrs.getSnapshot(), stopped, 'stopped AHRS receives neither GPS updates nor display ticks');
  assert.equal(s.callbacks.length, 1);
});

test('AHRS runs without Ownship and either plugin can release its lease without disrupting the other', async t => {
  const s = setup(t);
  let imu!: (sample: ImuSample) => void;
  const ahrs = createAhrsLayer(s.gps, { now: s.now, timeOrigin: s.origin,
    motion: (_mount, sample) => { imu = sample; return { start: async () => {}, stop() {} }; },
  });
  t.after(ahrs.stop);
  await ahrs.calibrate();
  for (let i = 0; i < 220; i++) {
    t.mock.timers.tick(50);
    if (i % 20 === 0) s.fix();
    imu({ time: s.now(), gyro: [0, 0, 0], specificForce: [0, 0, -G] });
  }
  assert.equal(ahrs.readDisplaySnapshot().phase, 'ready');
  assert.equal(ahrs.readDisplaySnapshot().gpsUsable, true);
  assert.equal(ahrs.readDisplaySnapshot().hsiHeading?.source, 'gps');
  assert.equal(s.callbacks.length, 1, 'AHRS started GPS without constructing Ownship');

  const ownship = createOwnshipLayer(s.gps);
  t.after(ownship.detach);
  ownship.setEnabled(true); ownship.attach();
  assert.equal(s.callbacks.length, 1, 'Ownship joins the same watch');
  const before = ahrs.readDisplaySnapshot().hsiHeading!.degrees;
  ownship.detach();
  const detached = ownship.getSnapshot();
  for (let i = 0; i < 10; i++) {
    t.mock.timers.tick(50);
    imu({ time: s.now(), gyro: [0, 0, 10 * RAD], specificForce: [0, 0, -G] });
  }
  s.fix();
  assert.equal(s.active.size, 1);
  assert.equal(s.callbacks.length, 1, 'unloading Ownship did not restart GPS');
  assert.equal(ownship.getSnapshot(), detached, 'unloaded Ownship no longer processes fixes');
  assert.ok(ahrs.readDisplaySnapshot().hsiHeading!.degrees > before + 2, 'AHRS keeps its gyro-driven heading');
  ownship.attach();
  assert.equal(ownship.getSnapshot().state, 'tracking');
  ahrs.stop();
  assert.equal(s.active.size, 1, 'stopping AHRS preserves Ownship GPS');
  assert.equal(s.callbacks.length, 1);
  t.mock.timers.tick(50); s.fix();
  assert.equal(ownship.getSnapshot().fix, s.gps.getSnapshot().fix);
  ownship.detach();
  assert.equal(s.active.size, 0);
});
