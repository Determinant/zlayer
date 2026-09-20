import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  AirwayDataResponse,
  AirwayRecord,
} from '@zlayer/contracts';

import {
  createAirwayChainResolver,
  createAirwayPathResolver,
  expandAirwayRoute,
  isAirwayIdentifier,
} from '../src/index.js';

test('finds forward and reverse paths on the same airway component', () => {
  const resolve = createAirwayPathResolver(airways([
    airway('airway:Y:C:V25', 'V25', ['SNS', 'MOVER', 'SANTY', 'OSI', 'SFO']),
    airway('airway:Y:H:V25', 'V25', ['ITO', 'KENNZ', 'CLUTS']),
  ]));

  const forward = resolve('v25', 'sns', 'sfo');
  assert.equal(forward.ok, true);
  if (forward.ok) {
    assert.equal(forward.path.airwayId, 'airway:Y:C:V25');
    assert.equal(forward.path.direction, 'forward');
    assert.deepEqual(forward.path.points.map(({ ident }) => ident), [
      'SNS', 'MOVER', 'SANTY', 'OSI', 'SFO',
    ]);
  }

  const reverse = resolve('V25', 'SFO', 'SNS');
  assert.equal(reverse.ok, true);
  if (reverse.ok) {
    assert.equal(reverse.path.direction, 'reverse');
    assert.deepEqual(reverse.path.points.map(({ ident }) => ident), [
      'SFO', 'OSI', 'SANTY', 'MOVER', 'SNS',
    ]);
  }
});

test('rejects disconnected and genuinely ambiguous airway joins', () => {
  const disconnected = createAirwayPathResolver(airways([
    airway('airway:Y:C:V25', 'V25', ['SNS', 'SFO']),
    airway('airway:Y:H:V25', 'V25', ['ITO', 'CLUTS']),
  ]));
  assert.deepEqual(disconnected('V25', 'SNS', 'CLUTS'), {
    ok: false,
    reason: 'no-path',
  });

  const ambiguous = createAirwayPathResolver(airways([
    airway('airway:Y:C:V1:a', 'V1', ['AAA', 'MID1', 'BBB']),
    airway('airway:Y:C:V1:b', 'V1', ['AAA', 'MID2', 'BBB']),
  ]));
  assert.deepEqual(ambiguous('V1', 'AAA', 'BBB'), {
    ok: false,
    reason: 'ambiguous',
  });
});

test('expands airway tokens but preserves explicit token ownership', () => {
  const resolve = createAirwayChainResolver(airways([
    airway('airway:Y:C:V25', 'V25', ['SNS', 'MOVER', 'SFO']),
    airway('airway:Y:C:T259', 'T259', ['SFO', 'OAK', 'NIKOL']),
  ]));
  const expansion = expandAirwayRoute(['SNS', 'V25', 'SFO', 'T259', 'NIKOL'], resolve);

  assert.deepEqual(expansion.points.map(({ ident }) => ident), [
    'SNS', 'MOVER', 'SFO', 'OAK', 'NIKOL',
  ]);
  assert.deepEqual(expansion.points.map(point => point.atom?.source.tokenIndex), [
    0, undefined, 2, undefined, 4,
  ]);
  assert.deepEqual(expansion.points.map(point => point.owners.find(owner => owner.kind === 'airway')?.source.tokenIndex), [
    undefined, 1, 1, 3, 3,
  ]);
  assert.deepEqual(expansion.airways.map(point => point.tokenIndex), [1, 3]);
  assert.deepEqual(expansion.transitions, []);
  assert.deepEqual(expansion.issues, []);
});

test('infers the shortest unique transition between adjacent airways', () => {
  const v25 = airway('airway:Y:C:V25', 'V25', ['SNS', 'MOVER', 'SFO', 'PYE']);
  v25.segments[0]!.distanceNm = 10;
  v25.segments[1]!.distanceNm = 10;
  v25.segments[2]!.distanceNm = 100;
  const v150 = airway('airway:Y:C:V150', 'V150', ['SFO', 'SUTRO', 'SAC', 'PYE']);
  v150.segments[0]!.distanceNm = 10;
  v150.segments[1]!.distanceNm = 10;
  v150.segments[2]!.distanceNm = 10;
  const data = airways([v25, v150]);
  const resolve = createAirwayChainResolver(data);
  const result = resolve(['V25', 'V150'], 'SNS', 'SAC');
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.chain.paths.map((path) => [
      path.ident,
      path.points[0]?.ident,
      path.points.at(-1)?.ident,
    ]), [
      ['V25', 'SNS', 'SFO'],
      ['V150', 'SFO', 'SAC'],
    ]);
  }

  const expansion = expandAirwayRoute(['SNS', 'V25', 'V150', 'SAC'], resolve);
  assert.deepEqual(expansion.points.map(({ ident }) => ident), [
    'SNS', 'MOVER', 'SFO', 'SUTRO', 'SAC',
  ]);
  assert.deepEqual(expansion.transitions, [{
    ident: 'SFO',
    beforeAirwayTokenIndex: 1,
    afterAirwayTokenIndex: 2,
  }]);
  assert.deepEqual(expansion.airways.map(({ entry, ident, exit }) => ({ entry, ident, exit })), [
    { entry: 'SNS', ident: 'V25', exit: 'SFO' },
    { entry: 'SFO', ident: 'V150', exit: 'SAC' },
  ]);
});

test('chooses the earliest crossover when airways overlap along the same route', () => {
  const resolve = createAirwayChainResolver(airways([
    airway('airway:Y:C:V25', 'V25', ['SNS', 'MOVER', 'SFO', 'SUTRO', 'GOBBS']),
    airway('airway:Y:C:V150', 'V150', ['SFO', 'SUTRO', 'GOBBS', 'SAC']),
  ]));
  const result = resolve(['V25', 'V150'], 'SNS', 'SAC');

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.chain.paths[0]?.points.at(-1)?.ident, 'SFO');
    assert.deepEqual(result.chain.paths.flatMap((path, index) =>
      (index === 0 ? path.points : path.points.slice(1)).map(({ ident }) => ident)
    ), ['SNS', 'MOVER', 'SFO', 'SUTRO', 'GOBBS', 'SAC']);
  }
});

test('rejects equal-cost transitions that produce different routes', () => {
  const v1 = airway('airway:Y:C:V1', 'V1', ['AAA', 'X', 'Y']);
  v1.segments[0]!.distanceNm = 1;
  v1.segments[1]!.distanceNm = 2;
  const v2 = airway('airway:Y:C:V2', 'V2', ['X', 'P', 'BBB', 'Q', 'Y']);
  v2.segments[0]!.distanceNm = 3;
  v2.segments[1]!.distanceNm = 5;
  v2.segments[2]!.distanceNm = 3;
  v2.segments[3]!.distanceNm = 3;

  const resolve = createAirwayChainResolver(airways([v1, v2]));
  assert.deepEqual(resolve(['V1', 'V2'], 'AAA', 'BBB'), {
    ok: false,
    reason: 'ambiguous',
  });
});

test('rejects competing routes when published distance is incomplete', () => {
  const resolve = createAirwayChainResolver(airways([
    airway('airway:Y:C:V1', 'V1', ['AAA', 'X', 'Y']),
    airway('airway:Y:C:V2', 'V2', ['X', 'P', 'BBB', 'Q', 'Y']),
  ]));

  assert.deepEqual(resolve(['V1', 'V2'], 'AAA', 'BBB'), {
    ok: false,
    reason: 'ambiguous',
  });
});

test('resolves more than two adjacent airways as one chain', () => {
  const resolve = createAirwayChainResolver(airways([
    airway('airway:Y:C:V1', 'V1', ['AAA', 'ONE', 'XXX']),
    airway('airway:Y:C:V2', 'V2', ['XXX', 'TWO', 'YYY']),
    airway('airway:Y:C:T3', 'T3', ['YYY', 'THREE', 'BBB']),
  ]));
  const expansion = expandAirwayRoute(['AAA', 'V1', 'V2', 'T3', 'BBB'], resolve);

  assert.deepEqual(expansion.transitions.map(({ ident }) => ident), ['XXX', 'YYY']);
  assert.deepEqual(expansion.points.map(({ ident }) => ident), [
    'AAA', 'ONE', 'XXX', 'TWO', 'YYY', 'THREE', 'BBB',
  ]);
  assert.deepEqual(expansion.issues, []);
});

test('recognizes only Victor and Tango identifiers and diagnoses placement', () => {
  assert.equal(isAirwayIdentifier('V25'), true);
  assert.equal(isAirwayIdentifier('t259'), true);
  assert.equal(isAirwayIdentifier('J5'), false);
  assert.equal(isAirwayIdentifier('VFR'), false);

  const expansion = expandAirwayRoute(['V25', 'SNS'], createAirwayChainResolver());
  assert.equal(expansion.issues[0]?.code, 'airway-placement');
  assert.match(expansion.issues[0]?.message ?? '', /route entry and exit/);
});

function airways(records: AirwayRecord[]): AirwayDataResponse {
  return {
    type: 'ZLayerAirways',
    metadata: { effectiveDate: '2026-09-03', source: 'test' },
    airways: records,
  };
}

test('airway gaps and missing segment records break paths in both directions and chained routes', () => {
  const record = airway('v55', 'V55', ['DQN', 'FWA', 'GFK', 'BIS']);
  record.segments[1]!.gap = true;
  const data = airways([record, airway('v1', 'V1', ['BIS', 'END'])]);
  const resolve = createAirwayPathResolver(data);
  assert.equal(resolve('V55', 'DQN', 'FWA').ok, true);
  assert.equal(resolve('V55', 'GFK', 'BIS').ok, true);
  for (const [from, to] of [['FWA', 'GFK'], ['GFK', 'FWA'], ['DQN', 'BIS']]) {
    assert.deepEqual(resolve('V55', from!, to!), { ok: false, reason: 'no-path' });
  }
  assert.deepEqual(createAirwayChainResolver(data)(['V55', 'V1'], 'DQN', 'END'),
    { ok: false, reason: 'no-path' });
  record.segments.splice(1, 1);
  assert.equal(createAirwayPathResolver(data)('V55', 'DQN', 'BIS').ok, false);
  Object.assign(record.segments[0]!, { gap: undefined });
  assert.equal(createAirwayPathResolver(data)('V55', 'DQN', 'FWA').ok, false);
});

function airway(id: string, ident: string, points: string[]): AirwayRecord {
  return {
    id,
    ident,
    regulatory: true,
    points,
    segments: points.map((from, index) => ({
      sequence: (index + 1) * 10,
      from,
      gap: false,
      ...(index + 1 < points.length ? { to: points[index + 1] } : {}),
      fromType: index === 0 || index === points.length - 1 ? 'VOR/DME' : 'RP',
    })),
  };
}
