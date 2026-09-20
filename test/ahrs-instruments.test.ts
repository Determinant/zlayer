import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { InstrumentDisplay, mechanicalColumns, METERS_PER_FOOT, METERS_PER_KNOT_SECOND, MPH_PER_KNOT } from '../src/layers/ahrs/instrument-display';
import { DrumNumber } from '../src/layers/ahrs/flight-readings';

const near = (actual: number, expected: number, tolerance = .01) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
const fix = (time: number, feet: number | null, knots: number | null) => ({ time,
  altitude: feet === null ? null : feet * METERS_PER_FOOT,
  speed: knots === null ? null : knots * METERS_PER_KNOT_SECOND });

test('one-second GPS fixes drive continuous, frame-rate-independent drums without altering samples', () => {
  for (const hz of [30, 60, 144]) {
    const display = new InstrumentDisplay();
    let previous = display.update(fix(0, 9900, 95), 0);
    for (let i = 1; i <= 4 * hz; i++) {
      const now = i / hz, time = Math.floor(now);
      const sample = fix(time, 9900 + 40 * time, 95 + 2 * time), original = { ...sample };
      const current = display.update(sample, now);
      assert.deepEqual(sample, original);
      assert.ok(Math.abs(current.altitudeFeet! - previous.altitudeFeet!) < 8, 'a new fix cannot jump 40 feet');
      assert.ok(Math.abs(current.groundspeedKnots! - previous.groundspeedKnots!) < .4);
      if (now > 2 && now < 4) {
        assert.ok(current.altitudeFeet! > previous.altitudeFeet!, 'keeps moving between fixes');
        assert.ok(current.groundspeedKnots! > previous.groundspeedKnots!);
      }
      previous = current;
    }
    near(previous.altitudeFeet!, 10060);
    near(previous.groundspeedKnots!, 103);
    near(previous.groundspeedKnots! * MPH_PER_KNOT, 118.53028308);
  }
});

test('prediction stops after 1.25 seconds and stale/missing readings clear independently', () => {
  const display = new InstrumentDisplay();
  let values;
  for (let i = 0; i < 240; i++) {
    const now = i / 60, time = Math.min(1, Math.floor(now));
    values = display.update(fix(time, 9000 + 40 * time, 95), now);
  }
  near(values!.altitudeFeet!, 9090); // Last observed 9,040 + 40 ft/s × 1.25 s.
  assert.deepEqual(display.update(fix(1, 9040, 95), 4.01), { altitudeFeet: null, groundspeedKnots: null, verticalSpeed: null });
  values = display.update(fix(4.02, -120, 0), 4.02);
  near(values.altitudeFeet!, -120); near(values.groundspeedKnots!, 0);
  values = display.update(fix(4.03, null, 10), 4.03);
  assert.equal(values.altitudeFeet, null);
  assert.notEqual(values.groundspeedKnots, null);
  assert.deepEqual(display.update(null, 4.04), { altitudeFeet: null, groundspeedKnots: null, verticalSpeed: null });
  values = display.update(fix(4.05, 12000, 140), 4.05);
  near(values.altitudeFeet!, 12000); near(values.groundspeedKnots!, 140);
  values = display.update(fix(8, 12500, 150), 8);
  near(values.altitudeFeet!, 12500, .0001); // Tab resumed: no sweep from an old altitude.
  assert.deepEqual(display.update(fix(10, 12500, 150), 8.01), { altitudeFeet: null, groundspeedKnots: null, verticalSpeed: null });
});

test('descent and deceleration remain smooth, and speed never goes negative', () => {
  const display = new InstrumentDisplay();
  let previous = display.update(fix(0, 10040, 5), 0);
  for (let i = 1; i < 240; i++) {
    const now = i / 60, time = Math.floor(now);
    const values = display.update(fix(time, 10040 - 40 * time, Math.max(0, 5 - 2 * time)), now);
    assert.ok(values.altitudeFeet! <= previous.altitudeFeet!);
    assert.ok(Math.abs(values.altitudeFeet! - previous.altitudeFeet!) < 4);
    assert.ok(values.groundspeedKnots! >= 0);
    previous = values;
  }
});

test('altitude drums carry through powers of ten, including space for the next leading digit', () => {
  for (const value of [0, 20, 100, 9980, 10000, 19980, 20000, 99980, 100000, -120]) {
    const columns = mechanicalColumns(value, 20, 5);
    assert.equal(Number(columns.slice().reverse().map(column => column.current).join('')), Math.abs(value));
    assert.ok(columns.every(column => column.phase === 0));
  }
  for (const [value, next] of [[9990, 10000], [19990, 20000], [99990, 100000]] as const) {
    const columns = mechanicalColumns(value, 20, 5);
    assert.ok(columns.every(column => column.phase === .5));
    assert.equal(Number(columns.slice().reverse().map(column => column.next).join('')), next);
  }
  const partial = mechanicalColumns(10990, 20, 5);
  assert.equal(partial.at(-1)!.phase, 0, 'unaffected leading digit stays still');
  assert.equal(partial[2]!.phase, .5);
});

test('speed drums roll single knots and carry 99 to 100 and 999 to 1000', () => {
  for (const [value, next] of [[9.5, 10], [99.5, 100], [199.5, 200], [999.5, 1000]] as const) {
    const columns = mechanicalColumns(value, 1, 3);
    assert.equal(columns[0]!.phase, .5);
    assert.equal(Number(columns.slice().reverse().map(column => column.phase > 0 ? column.next : column.current).join('')), next);
  }
  assert.equal(mechanicalColumns(98.5, 1, 3)[1]!.phase, 0);
  assert.throws(() => mechanicalColumns(Infinity, 20, 5), /Invalid/);
});

test('every digit boundary preserves the adjacent readings and rolls only the columns that change', () => {
  for (const step of [1, 20] as const) {
    const minimumDigits = step === 1 ? 3 : 5;
    const boundaries = [step, 10, 100, 200, 1000, 1100, 10000, 10100, 20000, 100000, 1_000_000]
      .filter(value => value >= step && value % step === 0);
    for (const boundary of boundaries) {
      for (const offset of [-1, -.99, -.75, -.5, -.01, 0, .01, .5, 1]) {
        const magnitude = boundary + offset * step;
        if (magnitude >= 1_000_000) continue;
        const lower = Math.floor(magnitude / step) * step, upper = lower + step;
        const fraction = (magnitude - lower) / step;
        for (const sign of [1, -1]) {
          const columns = mechanicalColumns(sign * magnitude, step, minimumDigits);
          const reading = (next: boolean) => Number(columns.slice().reverse()
            .map(column => next && column.phase > 0 ? column.next : column.current).join(''));
          assert.equal(reading(false), lower, `current row at ${sign * magnitude}, step ${step}`);
          assert.equal(reading(true), fraction > 0 ? upper : lower, `next row at ${sign * magnitude}, step ${step}`);
          let place = 0;
          for (const column of columns) {
            const changes = Math.floor(lower / 10 ** place) !== Math.floor(upper / 10 ** place);
            near(column.phase, changes ? fraction : 0, 1e-8);
            place += column.digits;
          }
        }
      }
    }
  }
});

test('drums provide readable values, signed altitude, unavailable and range states', () => {
  const render = (value: number | null) => renderToStaticMarkup(createElement(DrumNumber,
    { value, step: 20, minimumDigits: 5, label: 'GPS altitude', unit: 'feet' }));
  assert.match(render(-120), /aria-label="GPS altitude: -120 feet"/);
  assert.match(render(-120), />−<\/text>/);
  assert.match(render(null), /GPS altitude: unavailable/);
  assert.match(render(NaN), /GPS altitude: unavailable/);
  assert.match(render(1e6), /GPS altitude: out of range/);
});
