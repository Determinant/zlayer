import assert from 'node:assert/strict';
import test from 'node:test';
import { pirepAircraftName } from '../src/layers/weather-awc/pireps/aircraft';
import names from '../src/layers/weather-awc/pireps/aircraft-types.json';

test('the complete FAA designator snapshot names airliners, GA, helicopters and the active amendment', () => {
  assert.equal(Object.keys(names).length, 2704);
  for (const [code, name] of Object.entries(names)) {
    assert.match(code, /^[A-Z0-9]{2,4}$/);
    assert.ok(name.trim() && name.length <= 100, code);
    assert.doesNotMatch(name, /MANUFACTURER|Appendix|\(any manufacturer\)/, code);
    assert.equal(pirepAircraftName({ type: 'PIREP', aircraft: code }), name);
  }
  for (const [code, expected] of [
    ['B738', 'Boeing 737-800'], ['C172', 'Cessna 172 Skyhawk'], ['DA62', 'Diamond DA-62'],
    ['SR22', 'Cirrus SR-22'], ['R22', 'Robinson R-22'], ['R44', 'Robinson R-44'], ['A002', 'Irkut A-002'],
    ['P28A', 'Piper PA-28 Cherokee / Warrior / Archer'], ['EL2', 'Electra EL-2'],
  ] as const) assert.equal(pirepAircraftName({ type: 'Urgent PIREP', aircraft: code }), expected);
});

test('type lookup preserves unknowns and does not mistake flight identifiers for aircraft types', () => {
  assert.equal(pirepAircraftName({ type: 'PIREP', aircraft: ' c172 ' }), 'Cessna 172 Skyhawk');
  for (const aircraft of ['', 'ZZZZ', 'UNKNOWN', 'C172/G', 'C172?', 'UAL172', 'constructor', '__proto__']) {
    assert.equal(pirepAircraftName({ type: 'PIREP', aircraft }), undefined, aircraft);
  }
  for (const type of ['AIREP', 'AMDAR', 'Unknown']) {
    assert.equal(pirepAircraftName({ type, aircraft: 'C172' }), undefined, type);
  }
});
