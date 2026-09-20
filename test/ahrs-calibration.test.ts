import assert from 'node:assert/strict';
import test from 'node:test';
import { FlightAlignment } from '../src/layers/ahrs/estimator/flight-alignment';
import { G, RAD, type Vec3 } from '../src/layers/ahrs/estimator/math';
import { vibratingLevelFlight } from './helpers/ahrs-motion';

const createGate = () => new FlightAlignment({ requireVerticalEvidence: false, allowUnaided: true });

test('calibration keeps collected evidence through pauses without counting missing time or biasing averages', () => {
  const gate = new FlightAlignment({ allowUnaided: true, pauseOnGap: true });
  const continuous = createGate();
  for (let i = 0; i <= 500; i++) {
    const observedTime = i / 50;
    const sample = vibratingLevelFlight(observedTime);
    continuous.observeImu(sample);
    // The same readings arrive in three segments, separated by missing data.
    const time = observedTime + (i > 200 ? 2 : 0) + (i > 350 ? 3 : 0);
    gate.observeImu({ ...sample, time });
    if (i === 200 || i === 350) {
      const before = gate.snapshot(time);
      const paused = gate.snapshot(time + 1);
      assert.equal(paused.reason, 'imu-stale');
      assert.equal(paused.elapsed, before.elapsed);
      assert.equal(paused.solution, null);
      gate.observeImu({ ...sample, time: time + (i === 200 ? 2 : 3) });
    }
    if (i === 351) {
      assert.equal(gate.snapshot(time).reason, 'collecting-imu', 'twelve wall-clock seconds are not ten observed seconds');
      assert.ok(gate.snapshot(time).elapsed < 7.1);
    }
  }
  const result = gate.snapshot(15), baseline = continuous.snapshot(10).solution!;
  assert.equal(result.reason, 'ready', JSON.stringify(result.issue));
  assert.ok(Math.abs(result.elapsed - 10) < 1e-9, 'both missing intervals contribute zero evidence');
  assert.equal(result.solution!.time, 15, 'alignment keeps the real monotonic clock');
  result.solution!.gyroBias.forEach((value, axis) => assert.ok(Math.abs(value - baseline.gyroBias[axis]!) < 1e-9));
  result.solution!.specificForce.forEach((value, axis) => assert.ok(Math.abs(value - baseline.specificForce[axis]!) < 1e-9));
  assert.ok(result.solution!.gyroBiasStd > .5 * RAD);
});

test('a pause does not hide movement, and later steady readings replace the rejected window', () => {
  const gate = new FlightAlignment({ allowUnaided: true, pauseOnGap: true });
  for (let i = 0; i <= 200; i++) gate.observeImu({ time: i / 50, gyro: [0, 0, 0], specificForce: [0, 0, -G] });
  // Isolated readings during a long pause cannot advance progress or replace evidence.
  for (let time = 5; time <= 100; time++) gate.observeImu({ time, gyro: [0, 0, 0], specificForce: [0, 0, -G] });
  assert.equal(gate.snapshot(100).elapsed, 4);
  for (let i = 1; i <= 300; i++) gate.observeImu({ time: 100 + i / 50, gyro: [2 * RAD, 0, 0], specificForce: [0, 0, -G] });
  assert.equal(gate.snapshot(106).reason, 'imu-unstable');
  for (let i = 1; i <= 550; i++) gate.observeImu({ time: 106 + i / 50, gyro: [0, 0, 0], specificForce: [0, 0, -G] });
  const result = gate.snapshot(117);
  assert.equal(result.reason, 'ready');
  assert.ok(result.elapsed <= 10.25 + 1e-9, 'the window stays bounded in observed time');
  assert.deepEqual(result.solution!.gyroBias, [0, 0, 0]);
});

test('the reusable calibration gate still restarts after a gap unless pause recovery is enabled', () => {
  const gate = createGate();
  for (let i = 0; i <= 200; i++) gate.observeImu({ time: i / 50, gyro: [0, 0, 0], specificForce: [0, 0, -G] });
  gate.observeImu({ time: 6, gyro: [0, 0, 0], specificForce: [0, 0, -G] });
  assert.equal(gate.snapshot(6).elapsed, 0);
  assert.equal(gate.snapshot(6).reason, 'collecting-imu');
});

for (const hz of [20, 50, 120]) for (const degrees of [0, 3, 10]) {
  test(`resumed calibration checks a ${degrees}° pose change before completing at ${hz} Hz`, () => {
    const gate = new FlightAlignment({ allowUnaided: true, pauseOnGap: true });
    const force: Vec3 = [0, -G * Math.sin(degrees * RAD), -G * Math.cos(degrees * RAD)];
    for (let i = 0; i <= Math.round(9.7 * hz); i++)
      gate.observeImu({ time: i / hz, gyro: [0, 0, 0], specificForce: [0, 0, -G] });
    const collected = gate.snapshot(9.7).elapsed;
    // Any rotation happened in the missing interval, so both segments have zero gyro rate.
    for (let i = 0; i <= Math.round(.6 * hz); i++) {
      const time = 20 + i / hz;
      gate.observeImu({ time, gyro: [0, 0, 0], specificForce: force });
      const state = gate.snapshot(time);
      if (i === 0) assert.equal(state.elapsed, collected, 'the gap contributes no evidence');
      if (i / hz < .5 || degrees === 10)
        assert.equal(state.solution, null, 'old readings must not bypass the resumed pose check');
    }
    const resumed = gate.snapshot(20.6);
    if (degrees < 5) {
      assert.equal(resumed.reason, 'ready', 'ordinary scrolling and a small pose change retain progress');
      assert.ok(resumed.elapsed >= collected);
    } else {
      assert.equal(resumed.reason, 'pose-changed');
      assert.ok(Math.abs(resumed.elapsed - .6) < 1e-9, 'keep every fresh reading, discarding the old pose');
      for (let i = Math.round(.6 * hz) + 1; i <= 10 * hz; i++)
        gate.observeImu({ time: 20 + i / hz, gyro: [0, 0, 0], specificForce: force });
      const complete = gate.snapshot(30);
      assert.equal(complete.reason, 'ready');
      complete.solution!.specificForce.forEach((value, axis) =>
        assert.ok(Math.abs(value - force[axis]!) < 1e-9, 'the level reference comes entirely from the new pose'));
    }
  });
}

test('an isolated vibration spike after a pause does not discard calibration progress', () => {
  const gate = new FlightAlignment({ allowUnaided: true, pauseOnGap: true });
  for (let i = 0; i <= 485; i++)
    gate.observeImu({ time: i / 50, gyro: [0, 0, 0], specificForce: [0, 0, -G] });
  gate.observeImu({ time: 20, gyro: [0, 0, 0], specificForce: [3, 0, -G] });
  assert.equal(gate.snapshot(20).solution, null);
  for (let i = 1; i <= 30; i++)
    gate.observeImu({ time: 20 + i / 50, gyro: [0, 0, 0], specificForce: [0, 0, -G] });
  const state = gate.snapshot(20.6);
  assert.equal(state.reason, 'ready');
  assert.ok(state.elapsed > 10, 'averaging the resumed readings preserves the previous progress');
});

test('a second pause requires fresh pose evidence from the latest segment', () => {
  const gate = new FlightAlignment({ allowUnaided: true, pauseOnGap: true });
  for (let i = 0; i <= 485; i++)
    gate.observeImu({ time: i / 50, gyro: [0, 0, 0], specificForce: [0, 0, -G] });
  for (let i = 0; i <= 10; i++)
    gate.observeImu({ time: 20 + i / 50, gyro: [0, 0, 0], specificForce: [0, 0, -G] });
  const force: Vec3 = [G * Math.sin(10 * RAD), 0, -G * Math.cos(10 * RAD)];
  for (let i = 0; i <= 20; i++) {
    gate.observeImu({ time: 30 + i / 50, gyro: [0, 0, 0], specificForce: force });
    assert.equal(gate.snapshot(30 + i / 50).solution, null);
  }
  for (let i = 21; i <= 30; i++)
    gate.observeImu({ time: 30 + i / 50, gyro: [0, 0, 0], specificForce: force });
  const state = gate.snapshot(30.6);
  assert.equal(state.reason, 'pose-changed');
  assert.ok(Math.abs(state.elapsed - .6) < 1e-9);
});

function randomNoise(seed: number) {
  const uniform = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed + .5) / 4294967296; };
  return () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
}

for (const hz of [20, 50, 60, 120]) test(`stationary calibration accepts bounded sensor noise at ${hz} Hz`, () => {
  for (const seed of [1, 53, 4096]) {
    const gate = createGate(), noise = randomNoise(seed);
    const bias: Vec3 = [.15 * RAD, -.1 * RAD, .2 * RAD];
    for (let i = 0; i <= 10 * hz; i++) {
      gate.observeImu({ time: 200 + i / hz,
        gyro: bias.map(value => value + .25 * RAD * noise()) as unknown as Vec3,
        specificForce: [0, 0, -G].map(value => value + .3 * noise()) as unknown as Vec3 });
    }
    const state = gate.snapshot(210);
    assert.equal(state.reason, 'ready', `seed=${seed}: ${JSON.stringify(state.issue)}`);
    assert.ok(state.solution);
    state.solution.gyroBias.forEach((value, axis) => assert.ok(Math.abs(value - bias[axis]!) < .06 * RAD));
    assert.ok(state.solution.gyroBiasStd >= .2 * RAD, 'noise averaging must preserve conservative bias uncertainty');
  }
});

for (const hz of [20, 50, 60, 120]) for (const gps of [false, true]) {
  test(`level-flight calibration tolerates gentle rocking and vibration at ${hz} Hz, GPS=${gps}`, () => {
    const gate = createGate();
    for (let i = 0; i <= 10 * hz; i++) {
      const time = i / hz;
      gate.observeImu(vibratingLevelFlight(time));
      if (gps && i % hz === 0) gate.observeGps({ time, speed: 50 + .5 * Math.sin(time), track: 75, accuracy: 5 });
    }
    const state = gate.snapshot(10);
    assert.equal(state.reason, 'ready', JSON.stringify(state.issue));
    const solution = state.solution!;
    assert.equal(solution.gpsVerified, gps);
    assert.ok(Math.abs(solution.gyroBias[0] / RAD - .15) < .07, 'small rocking must not become a large gyro bias');
    assert.ok(solution.gyroBiasStd > .5 * RAD, 'accepted rocking retains uncertainty about the bias');
    assert.ok(Math.abs(solution.specificForce[1]) < .05, 'calibration averages around the level pose');
  });
}

test('calibration weights rocking by elapsed time when the sensor cadence changes', () => {
  for (const origin of [0, 300.123]) for (const fastHz of [60, 120]) {
    const gate = createGate();
    for (let block = 0; block < 20; block++) {
      const sign = block % 2 ? -1 : 1, hz = sign > 0 ? fastHz : 20;
      for (let i = 0; i < hz / 2; i++) {
        gate.observeImu({ time: origin + block / 2 + i / hz,
          gyro: [(.1 + sign * .8) * RAD, 0, 0], specificForce: [sign * .1, 0, -G] });
      }
    }
    gate.observeImu({ time: origin + 10, gyro: [.1 * RAD, 0, 0], specificForce: [0, 0, -G] });
    const state = gate.snapshot(origin + 10);
    assert.equal(state.reason, 'ready', JSON.stringify(state.issue));
    assert.ok(Math.abs(state.solution!.gyroBias[0] / RAD - .1) < 1e-9,
      'faster sampling in one direction must not turn rocking into gyro bias');
    assert.ok(Math.abs(state.solution!.specificForce[0]) < 1e-9,
      'uneven sampling must not tilt the level reference');
    assert.ok(state.solution!.gyroBiasStd >= .79 * RAD, 'rocking retains its bias uncertainty');
  }
});

for (const mode of ['rotation', 'oscillation', 'acceleration', 'bad gravity', 'gyro noise', 'accelerometer noise'] as const) {
  test(`calibration rejects ${mode} with a measured reason, then recovers when steady`, () => {
    const gate = createGate();
    for (let i = 0; i <= 600; i++) {
      const time = i / 60, wave = Math.sin(2 * Math.PI * .5 * time), sign = i % 2 ? -1 : 1;
      gate.observeImu({ time,
        gyro: [mode === 'rotation' ? 2 * RAD : mode === 'oscillation' ? 4 * RAD * wave
          : mode === 'gyro noise' ? 20 * RAD * sign : 0, 0, 0],
        specificForce: [mode === 'acceleration' ? 2 * wave : mode === 'accelerometer noise' ? 4 * sign : 0,
          0, mode === 'bad gravity' ? -G / 2 : -G] });
    }
    const state = gate.snapshot(10);
    assert.equal(state.reason, 'imu-unstable');
    assert.equal(state.solution, null);
    assert.equal(state.issue?.kind, { rotation: 'gyro-rate', oscillation: 'gyro-change', acceleration: 'force-change',
      'bad gravity': 'force-magnitude', 'gyro noise': 'gyro-noise', 'accelerometer noise': 'force-noise' }[mode]);
    assert.ok(state.issue!.value > state.issue!.limit);
    for (let i = 601; i <= 1260; i++) gate.observeImu({ time: i / 60, gyro: [0, 0, 0], specificForce: [0, 0, -G] });
    assert.equal(gate.snapshot(21).reason, 'ready');
    assert.equal(gate.snapshot(21).issue, null);
  });
}

test('a recent movement and irregular sampling cannot disappear between averaging windows', () => {
  for (const origin of [0, .013, 300.123]) {
    const gate = createGate();
    for (let i = 0; i <= 1000; i++) {
      const time = i / 100 + (i % 2 ? .002 : 0);
      gate.observeImu({ time: origin + time,
        gyro: [time > 9.7 ? 8 * RAD : 0, 0, 0], specificForce: [0, 0, -G] });
    }
    assert.equal(gate.snapshot(origin + 10).reason, 'imu-unstable');
    assert.equal(gate.snapshot(origin + 10).issue?.kind, 'gyro-change');
  }
});
