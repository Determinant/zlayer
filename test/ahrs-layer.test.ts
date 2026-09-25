import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createAhrsLayer, type AhrsGpsSource } from '../src/layers/ahrs/layer';
import { Horizon } from '../src/layers/ahrs/horizon';
import { AhrsDiagnostics } from '../src/layers/ahrs/diagnostics';
import { Ahrs } from '../src/layers/ahrs/estimator/ahrs';
import { FlightAlignment } from '../src/layers/ahrs/estimator/flight-alignment';
import { G, RAD, conjugate, fromEuler, rotate, type Vec3 } from '../src/layers/ahrs/estimator/math';
import type { ImuSample } from '../src/layers/ahrs/estimator/types';
import type { MotionFactory } from '../src/layers/ahrs/motion';
import { turn } from './helpers/ahrs-motion';

const near = (actual: number, expected: number, tolerance = 1e-5) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);

function setup(t: test.TestContext, start: () => Promise<void> = async () => {}) {
  const origin = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: origin });
  const now = () => (Date.now() - origin) / 1000;
  const listeners = new Set<() => void>();
  let location: ReturnType<AhrsGpsSource['getSnapshot']> = { state: 'acquiring', fix: null };
  let leases = 0, stops = 0;
  const callbacks: ((sample: ImuSample) => void)[] = [];
  const issues: ((message: string) => void)[] = [];
  const motion: MotionFactory = (_mount, sample, issue) => {
    callbacks.push(sample);
    issues.push(issue);
    return { start, stop: () => { stops++; } };
  };
  const notify = () => listeners.forEach(listener => listener());
  const fix = (change: Partial<NonNullable<typeof location.fix>> = {}) => {
    location = { state: 'tracking', fix: {
      timestamp: Date.now(), time: now(), altitude: null, altitudeAccuracy: null, accuracy: 5, speed: 55, track: 75, estimated: false, coordinates: [-122, 37], ...change,
    } };
    notify();
  };
  const layer = createAhrsLayer({ getSnapshot: () => location,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    acquire() { leases++; return () => { leases--; }; }, retry() {},
  }, { now, timeOrigin: origin, motion });
  t.after(layer.stop);
  const imu = (gyro: Vec3 = [0, 0, 0], specificForce: Vec3 = [0, 0, -G]) =>
    callbacks.at(-1)!({ time: now(), gyro, specificForce });
  const feed = (seconds: number, options: { gps?: boolean; fix?: Parameters<typeof fix>[0]; gyro?: Vec3; force?: Vec3; trackRate?: number; hz?: number; rollRate?: number } = {}) => {
    const hz = options.hz ?? 20, initialRoll = (layer.readDisplaySnapshot().attitude?.roll ?? 0) * RAD;
    for (let i = 0; i < seconds * hz; i++) {
      t.mock.timers.tick(1000 / hz);
      if (options.gps !== false && i % hz === 0) fix({ track: 75 + (options.trackRate ?? 0) * now(), ...options.fix });
      if (options.rollRate !== undefined) {
        const roll = initialRoll + options.rollRate * i / hz;
        imu([options.rollRate, 0, 0], [0, -G * Math.sin(roll), -G * Math.cos(roll)]);
      } else imu(options.gyro, options.force);
    }
    notify();
  };
  return { layer, fix, feed, imu, callbacks, issues, notify,
    queueGpsNotification: () => {
      const pending = [...listeners];
      return () => pending.forEach(listener => listener());
    },
    loseGps: () => { location = { ...location, state: 'stale' }; notify(); },
    gpsStatus: (state: ReturnType<AhrsGpsSource['getSnapshot']>['state']) => { location = { ...location, state }; notify(); },
    leases: () => leases, stops: () => stops };
}

test('GPS supplies a provisional HSI heading carried by gyro motion, retained through loss and stowing, and cleared on stop', async t => {
  const s = setup(t);
  await s.layer.calibrate(); s.feed(11);
  const ready = s.layer.readDisplaySnapshot();
  assert.equal(ready.hsiHeading?.source, 'gps');
  near(ready.hsiHeading!.degrees, 75);
  assert.equal(ready.trueHeading, false, 'a provisional reference does not falsely validate filter heading');
  s.layer.setVisible(false);
  s.loseGps();
  s.feed(2, { gps: false, gyro: [0, 0, 10 * RAD] });
  const turned = s.layer.readDisplaySnapshot();
  assert.ok(turned.hsiHeading!.degrees > 85, 'gyro motion carries geographic heading without GPS or visible instruments');
  assert.equal(turned.warning, 'No GPS');
  s.layer.setVisible(true);
  near(s.layer.getSnapshot().hsiHeading!.degrees, turned.hsiHeading!.degrees);
  t.mock.timers.tick(4000);
  near(s.layer.readDisplaySnapshot().hsiHeading!.degrees, turned.hsiHeading!.degrees);
  s.layer.stop();
  assert.equal(s.layer.readDisplaySnapshot().hsiHeading, null);
  await s.layer.calibrate(); s.feed(11, { gps: false });
  assert.equal(s.layer.readDisplaySnapshot().hsiHeading, null, 'a new session without GPS starts relative');
});

test('in-progress calibration pauses without losing readings or counting the gap as progress', async t => {
  const s = setup(t);
  await s.layer.calibrate(); s.feed(4, { gps: false });
  const progress = s.layer.readDisplaySnapshot().progress;
  assert.ok(progress > .39 && progress < .41);
  t.mock.timers.tick(2500);
  const paused = s.layer.readDisplaySnapshot();
  assert.equal(paused.phase, 'calibrating');
  assert.equal(paused.calibrationReason, 'imu-stale');
  assert.equal(paused.progress, progress);
  s.imu();
  assert.equal(s.layer.readDisplaySnapshot().progress, progress);
  s.feed(3, { gps: false });
  assert.equal(s.layer.readDisplaySnapshot().phase, 'calibrating');
  assert.ok(s.layer.readDisplaySnapshot().progress < .71);
  s.feed(3, { gps: false });
  assert.equal(s.layer.readDisplaySnapshot().phase, 'ready');
  assert.equal(s.layer.readDisplaySnapshot().warning, 'No GPS');
  assert.equal(s.callbacks.length, 1, 'recovery does not restart the sensor session');
  assert.equal(s.leases(), 1);
});

test('a sensor timing issue keeps the session and resumes on the next good reading', async t => {
  const s = setup(t);
  await s.layer.calibrate(); s.feed(11);
  assert.equal(s.layer.getSnapshot().phase, 'ready');
  s.issues.at(-1)!('Skipped motion reading: timestamp ahead of receipt. Waiting for fresh readings.');
  const failed = s.layer.getSnapshot();
  assert.equal(failed.phase, 'ready');
  assert.equal(failed.warning, 'Motion');
  assert.equal(s.leases(), 1);
  const before = failed.attitude!.quaternion;
  s.fix();
  assert.equal(s.layer.getSnapshot().warning, 'Motion', 'GPS cannot clear a motion issue');
  s.feed(.05);
  assert.equal(s.layer.getSnapshot().warning, '');
  assert.deepEqual(s.layer.getSnapshot().attitude!.quaternion, before);
  assert.equal(s.layer.getSnapshot().phase, 'ready');
});

for (const finite of [true, false]) test(`a permanent estimator failure stays hidden through sensor pauses (finite attitude=${finite})`, async t => {
  const s = setup(t);
  await s.layer.calibrate(); s.feed(11);
  const getState = Ahrs.prototype.getState;
  const failedState = t.mock.method(Ahrs.prototype, 'getState', function (this: Ahrs, now: number) {
    const state = getState.call(this, now);
    return { ...state, status: 'interrupted' as const, reason: 'Estimator health check failed',
      roll: finite ? state.roll : NaN, pitch: finite ? state.pitch : NaN };
  });
  const hidden = () => {
    const state = s.layer.readDisplaySnapshot();
    assert.equal(state.warning, 'Calibration');
    assert.match(state.message, /Attitude estimation stopped/);
    assert.doesNotMatch(state.message, /resume automatically|Waiting for fresh/);
    assert.doesNotMatch(renderToStaticMarkup(createElement(Horizon, state)), /data-testid="ahrs-moving-horizon"/);
  };
  hidden();
  s.issues.at(-1)!('Incomplete motion reading. Waiting for fresh readings.');
  hidden();
  t.mock.timers.tick(1000);
  hidden();
  s.imu(); s.fix();
  hidden();
  // Only explicit recalibration supplies a working estimator again.
  failedState.mock.restore();
  await s.layer.calibrate(); s.feed(11);
  const recovered = s.layer.readDisplaySnapshot();
  assert.equal(recovered.warning, '');
  assert.match(renderToStaticMarkup(createElement(Horizon, recovered)), /data-testid="ahrs-moving-horizon"/);
});

test('a changed pose during calibration keeps collecting the new reference with visible progress', async t => {
  const s = setup(t);
  await s.layer.calibrate(); s.feed(9.7, { gps: false });
  t.mock.timers.tick(2000);
  const force: Vec3 = [0, -G * Math.sin(10 * RAD), -G * Math.cos(10 * RAD)];
  s.imu([0, 0, 0], force);
  s.feed(.6, { gps: false, force });
  const changed = s.layer.readDisplaySnapshot();
  assert.equal(changed.phase, 'calibrating');
  assert.equal(changed.calibrationReason, 'pose-changed');
  assert.ok(changed.progress > .05 && changed.progress < .07);
  assert.equal(changed.attitude, null);
  s.feed(9.5, { gps: false, force });
  assert.equal(s.layer.readDisplaySnapshot().phase, 'ready');
  assert.equal(s.callbacks.length, 1, 'replacing the old reference keeps the sensor session');
  near(s.layer.readDisplaySnapshot().attitude!.roll, 0);
});

test('stop clears GPS instruments even while another consumer keeps the source live', async t => {
  const s = setup(t);
  s.fix({ altitude: 3048, altitudeAccuracy: 10 });
  assert.equal(s.layer.readDisplaySnapshot().gpsLive, false, 'idle AHRS has no GPS session');
  await s.layer.calibrate(); s.feed(11, { fix: { altitude: 3048, altitudeAccuracy: 10 } });
  assert.equal(s.layer.getSnapshot().gpsLive, true);
  assert.equal(s.layer.getSnapshot().altitude, 3048);
  s.layer.stop();
  assert.equal(s.leases(), 0);
  s.fix({ speed: 20, altitude: 4000 });
  t.mock.timers.tick(15_000);
  s.layer.setVisible(false); s.layer.setVisible(true);
  for (const state of [s.layer.getSnapshot(), s.layer.readDisplaySnapshot()]) {
    assert.equal(state.phase, 'idle');
    assert.equal(state.gpsLive, false);
    assert.equal(state.gpsUsable, false);
    for (const key of ['speed', 'altitude', 'altitudeAccuracy', 'track', 'position', 'gpsTime'] as const)
      assert.equal(state[key], null, key);
  }
  await s.layer.calibrate(); s.feed(11);
  assert.equal(s.layer.getSnapshot().gpsLive, true, 'a fresh calibration owns new GPS updates');
});

test('one confirmed flight window levels a tilted mount and removes gyro bias together', async t => {
  const s = setup(t);
  const mounting = fromEuler(4 * RAD, 6 * RAD, 0);
  const force = rotate(conjugate(mounting), [0, 0, -G]);
  const gyro: Vec3 = [.001, -.001, .002];
  assert.equal(s.leases(), 0, 'opening the tool does not request location');
  await s.layer.calibrate();
  assert.equal(s.leases(), 1);
  s.feed(11, { gyro, force });
  const state = s.layer.getSnapshot();
  assert.equal(state.phase, 'ready');
  assert.equal(state.crossed, false);
  assert.deepEqual(state.position, [-122, 37], 'the HSI receives the shared GPS position');
  near(state.attitude!.roll, 0);
  near(state.attitude!.pitch, 0);
  const expectedBias = rotate(mounting, gyro);
  state.attitude!.bias.forEach((v, i) => near(v, expectedBias[i]!));
  assert.equal(state.attitude!.headingReference, 'relative');
  assert.equal(state.attitude!.gpsAiding, false, 'GPS track cannot silently become heading');
  s.feed(5, { gyro, force });
  near(s.layer.getSnapshot().attitude!.roll, 0);
  near(s.layer.getSnapshot().attitude!.pitch, 0);
  s.layer.stop();
  assert.equal(s.leases(), 0);
  assert.equal(s.stops(), 1);
});

test('display reads see IMU changes between publications without advancing or publishing the estimator', async t => {
  const s = setup(t);
  await s.layer.calibrate(); s.feed(11);
  const published = s.layer.getSnapshot();
  let notifications = 0;
  const unsubscribe = s.layer.subscribe(() => { notifications++; });
  t.after(unsubscribe);
  t.mock.timers.tick(16); s.imu([10 * RAD, 0, 0]);
  t.mock.timers.tick(16); s.imu([10 * RAD, 0, 0]);
  const display = s.layer.readDisplaySnapshot();
  assert.ok(display.attitude!.roll > published.attitude!.roll);
  for (let i = 0; i < 120; i++) assert.deepEqual(s.layer.readDisplaySnapshot(), display);
  assert.equal(s.layer.getSnapshot(), published, 'display reads leave the subscribed snapshot untouched');
  assert.equal(notifications, 0);
  t.mock.timers.tick(18);
  near(s.layer.getSnapshot().attitude!.roll, display.attitude!.roll, 1e-12);
  assert.equal(notifications, 1, 'the existing status publication cadence is unchanged');
});

for (const visible of [true, false]) test(`GPS loss crosses ${visible ? 'open' : 'stowed'} AHRS while attitude keeps moving`, async t => {
  const s = setup(t);
  await s.layer.calibrate();
  s.feed(11);
  const calibrated = s.layer.readDisplaySnapshot().attitude!;
  s.layer.setVisible(visible);
  s.loseGps();
  assert.equal(s.layer.readDisplaySnapshot().warning, 'No GPS');
  assert.equal(s.layer.readDisplaySnapshot().position, null, 'stale position cannot drive route guidance');
  s.feed(1, { gps: false, rollRate: 10 * RAD, hz: 60 });
  const coasting = s.layer.readDisplaySnapshot();
  assert.ok(coasting.attitude!.roll > 9);
  assert.equal(coasting.crossed, true);
  coasting.attitude!.bias.forEach((value, i) => near(value, calibrated.bias[i]!, 1e-6));
  coasting.attitude!.accelBias.forEach((value, i) => near(value, calibrated.accelBias[i]!, 1e-5));
  assert.equal(coasting.phase, 'ready', 'GPS loss does not restart calibration');
  s.fix();
  assert.equal(s.layer.readDisplaySnapshot().crossed, false);
  s.feed(3.1, { gps: false });
  assert.equal(s.layer.readDisplaySnapshot().warning, 'No GPS');
  s.layer.setVisible(true);
  assert.equal(s.layer.getSnapshot().warning, 'No GPS', 'freshness does not rely on ownship’s longer timeout');
});

for (const visible of [true, false]) test(`motion resumes automatically after a gap in ${visible ? 'open' : 'stowed'} AHRS`, async t => {
  const s = setup(t);
  await s.layer.calibrate(); s.feed(11);
  s.layer.setVisible(visible);
  t.mock.timers.tick(800);
  assert.equal(s.layer.readDisplaySnapshot().warning, 'Motion');
  assert.match(s.layer.readDisplaySnapshot().message, /resume automatically/);
  const before = s.layer.readDisplaySnapshot().attitude!;
  s.imu(); s.fix();
  assert.equal(s.layer.readDisplaySnapshot().warning, 'Uncertainty');
  assert.deepEqual(s.layer.readDisplaySnapshot().attitude!.bias, before.bias);
  assert.deepEqual(s.layer.readDisplaySnapshot().attitude!.quaternion, before.quaternion);
  s.feed(.5, { rollRate: 10 * RAD });
  assert.ok(s.layer.readDisplaySnapshot().attitude!.roll > before.roll + 4);
  s.layer.setVisible(true);
  assert.equal(s.layer.getSnapshot().phase, 'ready');
  assert.equal(s.leases(), 1);
});

for (const mode of ['lost', 'missing', 'slow'] as const) for (const visible of [true, false]) {
  test(`steady IMU bounds uncertainty with ${mode} GPS while ${visible ? 'open' : 'stowed'}`, async t => {
    const s = setup(t);
    const fix = mode === 'slow' ? { speed: 5, track: null } : undefined;
    await s.layer.calibrate();
    s.feed(11, { gps: mode !== 'missing', fix });
    const calibrated = s.layer.readDisplaySnapshot().attitude!;
    s.layer.setVisible(visible);
    if (mode === 'lost') s.loseGps();
    s.feed(60, { gps: mode === 'slow', fix });
    const state = s.layer.readDisplaySnapshot();
    assert.equal(state.phase, 'ready');
    assert.equal(state.attitude!.status, 'tracking');
    assert.ok(state.attitude!.tiltStd < 6);
    assert.equal(state.attitude!.tiltAiding, true);
    assert.equal(state.attitude!.tiltFusion.source, 'imu');
    assert.equal(state.warning, mode === 'slow' ? 'Low Speed' : 'No GPS');
    assert.equal(state.crossed, true);
    assert.equal(state.message, '');
    assert.deepEqual(state.attitude!.bias, calibrated.bias);
    assert.deepEqual(state.attitude!.accelBias, calibrated.accelBias);
    const rendered = renderToStaticMarkup(createElement(Horizon, state));
    assert.match(rendered, /data-testid="ahrs-moving-horizon"/);
    assert.match(rendered, /data-testid="ahrs-cross"/);
    s.feed(1, { gps: mode === 'slow', fix, rollRate: 10 * RAD });
    const moving = s.layer.readDisplaySnapshot();
    assert.ok(moving.attitude!.roll > state.attitude!.roll + 9, 'uncertain attitude still follows live motion');
    assert.match(renderToStaticMarkup(createElement(Horizon, moving)), /data-testid="ahrs-moving-horizon"/);

    s.fix();
    const recovering = s.layer.readDisplaySnapshot();
    assert.equal(recovering.warning, '', 'bounded tilt and fresh GPS clear the independent GPS warning');
    assert.equal(recovering.crossed, false);
    assert.match(renderToStaticMarkup(createElement(Horizon, recovering)), /data-testid="ahrs-moving-horizon"/);
    assert.deepEqual(recovering.attitude!.quaternion, moving.attitude!.quaternion, 'GPS recovery preserves the calibrated attitude');

    t.mock.timers.tick(800);
    const stopped = s.layer.readDisplaySnapshot();
    assert.equal(stopped.warning, 'Motion', 'missing motion marks the last indication as paused');
    assert.match(renderToStaticMarkup(createElement(Horizon, stopped)), /data-testid="ahrs-moving-horizon"/);
  });
}

for (const hz of [50, 60, 120]) test(`stowing preserves every ${hz} Hz sample without display publications`, async t => {
  const s = setup(t);
  await s.layer.calibrate('upright', 60); s.feed(11);
  const update = t.mock.method(Ahrs.prototype, 'update');
  s.feed(1, { hz });
  assert.equal(update.mock.callCount(), hz, 'open AHRS keeps its normal input rate');
  s.layer.setVisible(false);
  const frozen = s.layer.getSnapshot();
  let publications = 0;
  t.after(s.layer.subscribe(() => { publications++; }));
  const before = update.mock.callCount();
  s.feed(2, { hz });
  const processed = update.mock.callCount() - before;
  assert.equal(processed, 2 * hz, 'integration must retain every delivered sample');
  assert.equal(s.layer.getSnapshot(), frozen, 'hidden GPS updates do not build display snapshots');
  assert.equal(publications, 0, 'the hidden display timer is stopped');
  const stowed = s.layer.readDisplaySnapshot();
  assert.equal(stowed.crossed, false);
  assert.equal(stowed.attitude!.gpsAiding, true);
  assert.ok(stowed.attitude!.fusion.accepted > frozen.attitude!.fusion.accepted, 'GPS fusion continues');
  assert.equal(s.leases(), 1);
  assert.equal(s.stops(), 0);
  s.loseGps();
  const lost = update.mock.callCount();
  s.feed(1, { hz, gps: false, rollRate: 10 * RAD });
  assert.equal(update.mock.callCount() - lost, hz, 'GPS loss does not stop stowed propagation');
  s.layer.setVisible(true);
  assert.equal(s.layer.getSnapshot().warning, 'No GPS', 'reopening immediately publishes current validity');
  assert.ok(s.layer.getSnapshot().attitude!.roll > 9);
  const resumed = update.mock.callCount();
  s.feed(1, { hz });
  assert.equal(update.mock.callCount() - resumed, hz);
  assert.equal(s.layer.getSnapshot().phase, 'ready');
  assert.equal(s.layer.getSnapshot().crossed, false);
});

test('stowed calibration receives every sample and retains its mount trim and gyro bias', async t => {
  const s = setup(t);
  const mounting = fromEuler(4 * RAD, 6 * RAD, 0);
  const force = rotate(conjugate(mounting), [0, 0, -G]);
  const gyro: Vec3 = [.001, -.001, .002];
  await s.layer.calibrate();
  s.feed(2, { hz: 60, gyro, force });
  s.layer.setVisible(false);
  const observe = t.mock.method(FlightAlignment.prototype, 'observeImu');
  s.feed(2, { hz: 60, gyro, force });
  assert.equal(observe.mock.callCount(), 120, 'stowing does not decimate calibration evidence');
  s.feed(9, { hz: 60, gyro, force });
  s.layer.setVisible(true);
  const state = s.layer.getSnapshot();
  assert.equal(state.phase, 'ready');
  assert.equal(state.crossed, false);
  near(state.attitude!.roll, 0);
  near(state.attitude!.pitch, 0);
  rotate(mounting, gyro).forEach((v, i) => near(state.attitude!.bias[i]!, v));
  s.layer.stop();
  assert.equal(s.leases(), 0);
  assert.equal(s.stops(), 1);
});

test('instrument readings share the GPS timestamp and clear on loss, expiry or missing altitude', async t => {
  const s = setup(t);
  await s.layer.calibrate();
  t.mock.timers.tick(50);
  s.fix({ altitude: 3048, altitudeAccuracy: 12 });
  assert.equal(s.layer.getSnapshot().altitude, 3048);
  assert.equal(s.layer.getSnapshot().altitudeAccuracy, 12);
  near(s.layer.getSnapshot().gpsTime!, .05);
  s.fix({ altitude: 0, speed: 0, track: null });
  assert.equal(s.layer.getSnapshot().altitude, 0, 'slow GPS still supplies altitude');
  assert.equal(s.layer.getSnapshot().speed, 0);
  for (const altitude of [null, NaN, Infinity]) {
    s.fix({ altitude });
    assert.equal(s.layer.getSnapshot().altitude, null);
    assert.equal(s.layer.getSnapshot().speed, 55, 'missing height does not hide speed');
  }
  s.fix({ altitude: -120 });
  assert.equal(s.layer.getSnapshot().altitude, -120);
  s.loseGps();
  assert.equal(s.layer.getSnapshot().altitude, null);
  assert.equal(s.layer.getSnapshot().altitudeAccuracy, null);
  assert.equal(s.layer.getSnapshot().gpsTime, null);
  s.fix({ altitude: 1000 });
  s.feed(3.1, { gps: false });
  assert.equal(s.layer.getSnapshot().altitude, null);
  assert.equal(s.layer.getSnapshot().speed, null);
  s.layer.stop();
  assert.equal(s.layer.getSnapshot().gpsTime, null);
});

test('fresh GPS below the flight-speed gate shows Low Speed without freezing attitude', async t => {
  const s = setup(t);
  await s.layer.calibrate(); s.feed(11);
  for (const speed of [0, 5, 9.99]) {
    t.mock.timers.tick(50); s.imu(); s.fix({ speed, track: null });
    const state = s.layer.getSnapshot();
    assert.equal(state.gpsLive, true, 'a current GPS fix is still received');
    assert.equal(state.gpsUsable, false);
    assert.equal(state.crossed, true);
    assert.equal(state.warning, 'Low Speed');
    assert.match(state.gpsMessage, /Steady velocity can still aid tilt/);
  }
  s.feed(1, { gps: false, rollRate: 10 * RAD });
  assert.ok(s.layer.getSnapshot().attitude!.roll > 9);
  assert.equal(s.layer.getSnapshot().warning, 'Low Speed');
  s.fix({ speed: 10 });
  assert.equal(s.layer.getSnapshot().gpsUsable, true);
  assert.equal(s.layer.getSnapshot().crossed, false);
});

for (const heading of [undefined, 120]) test(`stationary GPS bounds tilt after ${heading === undefined ? 'relative' : 'manual heading'} calibration`, async t => {
  const s = setup(t), fix = { speed: 0, track: null };
  await s.layer.calibrate('flat', heading);
  s.feed(11, { fix });
  s.feed(120, { fix, gyro: [.08 * RAD, -.08 * RAD, 0] });
  const state = s.layer.getSnapshot(), attitude = state.attitude!;
  assert.equal(state.phase, 'ready');
  assert.equal(state.gpsLive, true);
  assert.equal(state.gpsUsable, false, 'the flight-speed warning remains separate from tilt aiding');
  assert.equal(state.warning, 'Low Speed');
  assert.ok(attitude.tiltStd < 6);
  assert.ok(Math.abs(attitude.roll) < 1 && Math.abs(attitude.pitch) < 1);
  if (heading === undefined) {
    assert.ok(attitude.tiltFusion.accepted >= 5);
    assert.equal(attitude.tiltAiding, true);
    assert.equal(attitude.attitudeStd[2], Infinity);
  } else {
    assert.ok(attitude.fusion.accepted > 100);
    assert.equal(attitude.gpsAiding, true);
  }
  const markup = renderToStaticMarkup(createElement(AhrsDiagnostics, { layer: s.layer, active: false }));
  assert.match(markup, /ahrs-aiding-status is-aided/);
  assert.match(markup, /Gravity \/ acceleration aiding/);
});

for (const unavailable of ['missing', 'denied', 'unsupported', 'stale', 'stationary', 'slow', 'estimated', 'inaccurate'] as const) {
  test(`calibration completes with ${unavailable} GPS and retains a live indication under its GPS warning`, async t => {
    const s = setup(t);
    const mounting = fromEuler(4 * RAD, 6 * RAD, 0);
    const force = rotate(conjugate(mounting), [0, 0, -G]);
    const gyro: Vec3 = [.001, -.001, .002];
    await s.layer.calibrate();
    assert.equal(s.layer.getSnapshot().warning, 'Calibration', 'GPS absence does not replace the calibration state');
    if (unavailable === 'stale') s.fix();
    if (unavailable === 'denied' || unavailable === 'unsupported') s.gpsStatus(unavailable);
    const fix = unavailable === 'stationary' ? { speed: 0, track: null }
      : unavailable === 'slow' ? { speed: 5, track: null }
      : unavailable === 'estimated' ? { estimated: true }
      : unavailable === 'inaccurate' ? { accuracy: 100 } : undefined;
    s.feed(11, { gyro, force, gps: fix !== undefined, fix });
    const state = s.layer.getSnapshot();
    assert.equal(state.phase, 'ready');
    assert.equal(state.crossed, true);
    const warning = unavailable === 'stationary' || unavailable === 'slow' ? 'Low Speed' : 'No GPS';
    assert.equal(state.warning, warning);
    near(state.attitude!.roll, 0);
    near(state.attitude!.pitch, 0);
    rotate(mounting, gyro).forEach((value, i) => near(state.attitude!.bias[i]!, value));
    const before = state.attitude!.roll;
    s.feed(1, { gps: false, rollRate: 10 * RAD });
    assert.ok(s.layer.getSnapshot().attitude!.roll > before + 9, 'the crossed horizon continues to follow motion');
    assert.equal(s.layer.getSnapshot().warning, warning);
    assert.equal(s.leases(), 1);
    s.layer.stop();
    assert.equal(s.leases(), 0);
  });
}

test('GPS recovery clears its warning without repeating or resetting calibration', async t => {
  const s = setup(t);
  await s.layer.calibrate(); s.feed(11, { gps: false });
  const bias = s.layer.getSnapshot().attitude!.bias;
  s.feed(1);
  assert.equal(s.layer.getSnapshot().gpsUsable, true);
  assert.equal(s.layer.getSnapshot().phase, 'ready');
  assert.deepEqual(s.layer.getSnapshot().attitude!.bias, bias);
  assert.equal(s.layer.getSnapshot().crossed, false);
});

test('unaided calibration still rejects missing motion, rotation and changing usable GPS velocity', async t => {
  const s = setup(t);
  await s.layer.calibrate(); s.fix();
  t.mock.timers.tick(1000);
  assert.equal(s.layer.getSnapshot().calibrationReason, 'imu-stale', 'GPS cannot substitute for missing motion');
  s.feed(11, { trackRate: 2 });
  assert.equal(s.layer.getSnapshot().phase, 'calibrating');
  assert.equal(s.layer.getSnapshot().calibrationReason, 'gps-unstable');
  assert.equal(s.layer.getSnapshot().progress, 0, 'rejected GPS evidence must not show completed calibration');
  await s.layer.calibrate();
  s.feed(11, { gps: false, gyro: [2 * RAD, 0, 0] });
  assert.equal(s.layer.getSnapshot().phase, 'calibrating');
  assert.equal(s.layer.getSnapshot().calibrationReason, 'imu-unstable');
  assert.equal(s.layer.getSnapshot().progress, 0, 'a full rejected window is not calibration progress');
  assert.match(s.layer.getSnapshot().message, /Gyro average is too high: 2\.00°\/s \(limit 1\.00°\/s\)/);
  s.feed(11, { gps: false });
  assert.equal(s.layer.getSnapshot().phase, 'ready', 'fresh steady readings recover without restarting');
  assert.equal(s.layer.getSnapshot().progress, 1);
  assert.equal(s.layer.getSnapshot().message, '');
});

test('a long motion pause keeps calibration and resumes with visible uncertainty', async t => {
  const s = setup(t);
  await s.layer.calibrate(); s.feed(11, { gps: false });
  t.mock.timers.tick(5000);
  assert.equal(s.layer.readDisplaySnapshot().warning, 'Motion');
  s.imu(); s.fix();
  assert.equal(s.layer.readDisplaySnapshot().warning, 'Uncertainty');
  assert.equal(s.layer.readDisplaySnapshot().phase, 'ready');
  assert.ok(s.layer.readDisplaySnapshot().attitude!.tiltStd > 10);
});

test('a supplied independent heading enables GPS fusion without using track as heading', async t => {
  const s = setup(t);
  await s.layer.calibrate('upright', 60); s.feed(12);
  const state = s.layer.getSnapshot();
  assert.equal(state.attitude!.headingReference, 'manual-true');
  assert.equal(state.attitude!.gpsAiding, true);
  near(state.attitude!.yaw, 60);
  near(state.track!, 75);
});

test('GPS motion aligns heading, while an unsupported jump to low speed is rejected', async t => {
  const s = setup(t);
  await s.layer.calibrate();
  s.feed(11, { gps: false });
  for (let i = 1; i <= 45 * 50; i++) {
    t.mock.timers.tick(20);
    const truth = turn(i / 50, 120);
    s.imu(truth.sample.gyro, truth.sample.specificForce);
    if (i % 50 === 0) {
      const { time: _trajectoryTime, ...fix } = truth.fix;
      s.fix(fix);
    }
  }
  const state = s.layer.readDisplaySnapshot();
  assert.equal(state.phase, 'ready');
  assert.equal(state.attitude!.headingReference, 'gps-inertial');
  assert.equal(state.attitude!.gpsAiding, true);
  assert.equal(state.trueHeading, true);
  assert.equal(state.crossed, false);
  assert.equal(s.leases(), 1);
  const accepted = state.attitude!.fusion.accepted;
  const rejected = state.attitude!.fusion.rejected;
  s.feed(3, { fix: { speed: 5 } });
  assert.equal(s.layer.readDisplaySnapshot().warning, 'Low Speed');
  assert.equal(s.layer.readDisplaySnapshot().attitude!.gpsAiding, false);
  assert.equal(s.layer.readDisplaySnapshot().attitude!.fusion.accepted, accepted);
  assert.ok(s.layer.readDisplaySnapshot().attitude!.fusion.rejected > rejected);
});

test('cancelled motion permission and callbacks cannot restart a stopped tool', async t => {
  let grant!: () => void;
  const s = setup(t, () => new Promise<void>(resolve => { grant = resolve; }));
  const pending = s.layer.calibrate();
  assert.equal(s.layer.getSnapshot().phase, 'requesting');
  s.layer.stop(); grant(); await pending;
  s.callbacks[0]!({ time: 1, gyro: [0, 0, 0], specificForce: [0, 0, -G] });
  assert.equal(s.layer.getSnapshot().phase, 'idle');
  assert.equal(s.leases(), 0);
});

test('permission can finish while stowed, and repeated visibility changes leave one display timer', async t => {
  let grant!: () => void;
  const s = setup(t, () => new Promise<void>(resolve => { grant = resolve; }));
  const pending = s.layer.calibrate();
  s.layer.setVisible(false);
  grant(); await pending;
  s.feed(11, { hz: 60 });
  assert.equal(s.leases(), 1);
  assert.equal(s.layer.readDisplaySnapshot().phase, 'ready');
  for (let i = 0; i < 5; i++) {
    s.layer.setVisible(true); s.layer.setVisible(true); s.layer.setVisible(false);
  }
  s.layer.setVisible(true);
  let publications = 0;
  t.after(s.layer.subscribe(() => { publications++; }));
  t.mock.timers.tick(100);
  assert.equal(publications, 2, 'visibility changes cannot accumulate display timers');
  s.layer.setVisible(false);
  t.mock.timers.tick(100);
  assert.equal(publications, 2);
  s.layer.stop();
  const stopped = s.layer.getSnapshot();
  const afterStop = publications;
  t.mock.timers.tick(100);
  assert.equal(publications, afterStop, 'stopping while hidden cancels every timer');
  assert.equal(s.layer.getSnapshot(), stopped);
  assert.equal(s.leases(), 0);
});

test('invalid readings while stowed recover, while stop still rejects late callbacks', async t => {
  const s = setup(t);
  await s.layer.calibrate(); s.feed(11);
  s.layer.setVisible(false);
  const lateGps = s.queueGpsNotification();
  t.mock.timers.tick(40); s.imu([NaN, 0, 0]);
  const failed = s.layer.readDisplaySnapshot();
  assert.equal(failed.phase, 'ready');
  assert.equal(failed.warning, 'Motion');
  assert.match(failed.message, /Skipped an invalid/);
  assert.equal(s.leases(), 1);
  t.mock.timers.tick(40); s.imu();
  s.layer.setVisible(true);
  assert.equal(s.layer.getSnapshot().phase, 'ready');
  assert.equal(s.layer.getSnapshot().message, '');
  s.layer.stop();
  const published = s.layer.getSnapshot();
  lateGps();
  s.imu();
  assert.equal(s.layer.getSnapshot(), published, 'callbacks from the stopped session are ignored');
});

test('a motion adapter construction failure produces the normal error state', async () => {
  const layer = createAhrsLayer({
    getSnapshot: () => ({ state: 'acquiring', fix: null }),
    subscribe: () => assert.fail('GPS must not subscribe after a motion failure'),
    acquire: () => assert.fail('GPS must not start after a motion failure'),
    retry() {},
  }, { now: () => 0, timeOrigin: 0, motion: () => { throw new Error('Motion adapter unavailable'); } });
  await layer.calibrate();
  assert.equal(layer.getSnapshot().phase, 'error');
  assert.equal(layer.getSnapshot().message, 'Motion adapter unavailable');
});

test('permission denial releases resources, while an invalid reading keeps calibration running', async t => {
  let denied = true;
  const s = setup(t, async () => { if (denied) throw new Error('Allow motion access'); });
  await s.layer.calibrate();
  assert.equal(s.layer.getSnapshot().phase, 'error');
  assert.match(s.layer.getSnapshot().message, /Allow motion/);
  assert.equal(s.leases(), 0);
  denied = false; await s.layer.calibrate();
  s.imu([NaN, 0, 0]);
  assert.equal(s.layer.getSnapshot().phase, 'calibrating');
  assert.equal(s.layer.getSnapshot().crossed, true);
  assert.equal(s.leases(), 1);
  s.feed(11);
  assert.equal(s.layer.getSnapshot().phase, 'ready');
});
