import assert from 'node:assert/strict';
import test from 'node:test';
import { InstrumentDisplay, METERS_PER_FOOT, type InstrumentFix } from '../src/layers/ahrs/instrument-display';

const near = (actual: number, expected: number, tolerance = .01) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
const fix = (time: number, feet: number | null, altitudeAccuracy: number | null = 5): InstrumentFix => ({
  time, altitude: feet === null ? null : feet * METERS_PER_FOOT, speed: 50, altitudeAccuracy,
});
function simulate(seconds: number, sample: (time: number) => InstrumentFix | null, hz = 60) {
  const display = new InstrumentDisplay();
  return Array.from({ length: seconds * hz + 1 }, (_, frame) => {
    const now = frame / hz;
    const input = sample(now), original = input && { ...input };
    const values = display.update(input, now);
    assert.deepEqual(input, original, 'display never changes source samples');
    return { now, ...values };
  });
}

test('GPS VSI waits for a trend, then reports level, climb and descent in feet/minute at different fix rates', () => {
  for (const rate of [0, 600, -1200]) for (const interval of [.2, 1, 2]) {
    const values = simulate(8, now => {
      const time = Math.floor(now / interval + 1e-8) * interval;
      return fix(time, -120 + rate / 60 * time);
    });
    assert.ok(values.filter(value => value.now < 2).every(value => value.verticalSpeed === null));
    near(values.at(-1)!.verticalSpeed!.feetPerMinute, rate);
    assert.equal(values.at(-1)!.verticalSpeed!.roundedFeetPerMinute, rate);
  }
  const repeated = simulate(3, () => fix(0, 10000));
  assert.ok(repeated.every(value => value.verticalSpeed === null), 'one fix cannot establish a zero climb rate');
});

test('VSI damps climb/level/descent transitions continuously and independently of frame rate', () => {
  const runs = [30, 60, 144].map(hz => ({ hz, values: simulate(35, now => {
    const time = Math.floor(now);
    const height = 10000 + (time < 10 ? time * 10 : time < 20 ? 100 : 100 - (time - 20) * 10);
    return fix(time, height);
  }, hz) }));
  for (const { hz, values } of runs) {
    near(values[9 * hz]!.verticalSpeed!.feetPerMinute, 600);
    assert.ok(values[14 * hz]!.verticalSpeed!.feetPerMinute > 100);
    assert.ok(values[14 * hz]!.verticalSpeed!.feetPerMinute < 500);
    assert.ok(Math.abs(values[20 * hz]!.verticalSpeed!.feetPerMinute) < 30);
    near(values[35 * hz]!.verticalSpeed!.feetPerMinute, -600, 3);
    for (let i = 2 * hz + 1; i < values.length; i++) {
      const current = values[i]!.verticalSpeed!, previous = values[i - 1]!.verticalSpeed!;
      assert.ok(Math.abs(current.feetPerMinute - previous.feetPerMinute) < 10, 'damped rate cannot jump at a GPS fix');
      assert.equal(Math.abs(current.roundedFeetPerMinute % 100), 0);
    }
    near(values[14 * hz]!.verticalSpeed!.feetPerMinute, runs[0]!.values[14 * 30]!.verticalSpeed!.feetPerMinute, .01);
  }
});

test('GPS height noise is suppressed and readout hysteresis prevents chatter near a rounding boundary', () => {
  const noise = simulate(30, now => {
    const time = Math.floor(now);
    return fix(time, 10000 + (time % 2 ? 8 : -8));
  });
  for (const value of noise.filter(value => value.now >= 8)) {
    assert.ok(Math.abs(value.verticalSpeed!.feetPerMinute) < 75);
    assert.equal(value.verticalSpeed!.roundedFeetPerMinute, 0);
  }
  const climb = simulate(30, now => {
    const time = Math.floor(now);
    return fix(time, 10000 + time * 550 / 60 + (time % 2 ? .2 : -.2));
  });
  const digits = new Set(climb.filter(value => value.now >= 8).map(value => value.verticalSpeed!.roundedFeetPerMinute));
  assert.equal(digits.size, 1, '550-fpm boundary noise should not flicker between 500 and 600');
});

test('missing, stale, inaccurate and discontinuous altitude clear the VSI and require a new trend', () => {
  for (const fault of ['missing', 'stale', 'accuracy', 'jump', 'backwards', 'gap'] as const) {
    const values = simulate(16, now => {
      const time = Math.floor(now);
      if (time < 8) return fix(time, 10000 + time * 10);
      if (time < 12) {
        if (fault === 'missing') return fix(time, null);
        if (fault === 'stale') return fix(7, 10070);
        if (fault === 'accuracy') return fix(time, 10000 + time * 10, 100);
        if (fault === 'jump') return fix(time, 20000);
        if (fault === 'backwards') return fix(6, 10060);
        return time < 11 ? fix(7, 10070) : fix(11, 20000);
      }
      return fix(time, 20000);
    });
    if (fault === 'jump') assert.equal(values[8 * 60]!.verticalSpeed, null);
    else if (fault === 'stale' || fault === 'gap') assert.equal(values[11 * 60]!.verticalSpeed, null);
    else assert.equal(values[8 * 60]!.verticalSpeed, null);
    if (fault !== 'jump') assert.equal(values[12 * 60]!.verticalSpeed, null, 'first recovered altitude must not imply a climb');
    near(values.at(-1)!.verticalSpeed!.feetPerMinute, 0);
  }
  const display = new InstrumentDisplay();
  for (let i = 0; i <= 300; i++) display.update(fix(Math.floor(i / 60), 10000 + Math.floor(i / 60) * 10), i / 60);
  assert.equal(display.update(fix(10, 11000), 10).verticalSpeed, null, 'tab resume discards the previous trend');
});

test('invalid altitude accuracy rejects only VSI, while unreported accuracy remains usable', () => {
  for (const accuracy of [NaN, Infinity, -1, 31]) {
    const values = simulate(5, now => fix(Math.floor(now), 10000, accuracy));
    assert.equal(values.at(-1)!.verticalSpeed, null);
    assert.notEqual(values.at(-1)!.altitudeFeet, null);
    assert.notEqual(values.at(-1)!.groundspeedKnots, null);
  }
  assert.equal(simulate(5, now => fix(Math.floor(now), 10000, null)).at(-1)!.verticalSpeed!.roundedFeetPerMinute, 0);
});
