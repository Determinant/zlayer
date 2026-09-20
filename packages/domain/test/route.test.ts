import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  AirwayDataResponse,
  FeatureCollectionResponse,
  GeoPointFeature,
  NavigationLayerId,
} from '@zlayer/contracts';

import {
  createRouteResolver,
  routeTokensFromText,
} from '../src/index.js';

test('resolves route aliases into ordered legs', () => {
  const resolve = createRouteResolver([
    collection('airports', [point('airport:hwd', 'KHWD', -122.122, 37.659, 'HWD')]),
    collection('navaids', [point('navaid:sfo', 'SFO', -122.374, 37.62)]),
  ]);

  const route = resolve('hwd > sfo');
  assert.deepEqual(route.tokens, ['HWD', 'SFO']);
  assert.deepEqual(route.waypoints.map(({ ident }) => ident), ['KHWD', 'SFO']);
  assert.equal(route.legs.length, 1);
  assert.equal(route.unresolved.length, 0);
  assert.ok(route.distanceNm > 10 && route.distanceNm < 20);
});

test('direct VOR identifiers beat airport aliases at every route position, even beside the airport', () => {
  const resolve = createRouteResolver([
    collection('airports', [
      point('airport:sfo', 'KSFO', -122.375, 37.619, 'SFO'),
      point('airport:sns', 'KSNS', -121.607, 36.662, 'SNS'),
      point('airport:hwd', 'KHWD', -122.122, 37.659, 'HWD'),
    ]),
    collection('navaids', [
      point('navaid:sfo', 'SFO', -122.374, 37.62),
      point('navaid:sns', 'SNS', -121.603, 36.664),
    ]),
  ]);
  for (const input of ['sfo', 'SFO SNS', 'KSFO SFO SNS KSNS', 'KSNS SNS SFO', 'KSFO SFO']) {
    const route = resolve(input);
    assert.deepEqual(route.issues, [], input);
    assert.deepEqual(route.waypoints.map(({ ident }) => ident), route.tokens, input);
    for (const waypoint of route.waypoints) {
      assert.equal(waypoint.layer, waypoint.ident.startsWith('K') ? 'airports' : 'navaids', input);
    }
  }
  assert.equal(resolve('HWD').waypoints[0]?.ident, 'KHWD', 'unambiguous airport aliases still work');
  assert.equal(resolve('SFO', { 0: 'airport:sfo' }).waypoints[0]?.feature.id, 'airport:sfo', 'explicit selections override aliases');
  assert.equal(resolve('KSFO', { 0: 'navaid:sfo' }).waypoints[0]?.feature.id, 'navaid:sfo', 'pins retain their selected identity');
});

test('a VOR test transmitter sharing the VOR identifier does not win by proximity', () => {
  const vot = point('navaid:sfo-vot', 'SFO', -122.375, 37.619);
  vot.properties.type = 'VOT';
  const resolve = createRouteResolver([
    collection('airports', [point('airport:sfo', 'KSFO', -122.375, 37.619, 'SFO')]),
    collection('navaids', [vot, point('navaid:sfo', 'SFO', -122.374, 37.62)]),
  ]);
  assert.equal(resolve('KSFO SFO').waypoints[1]?.feature.id, 'navaid:sfo');
  assert.equal(resolve('SFO', { 0: vot.id! }).waypoints[0]?.feature.id, vot.id, 'an explicitly selected transmitter remains selected');
});

test('does not draw a leg across an unresolved token', () => {
  const resolve = createRouteResolver([
    collection('airports', [
      point('airport:hwd', 'KHWD', -122.122, 37.659),
      point('airport:sfo', 'KSFO', -122.375, 37.619),
    ]),
  ]);

  const route = resolve('KHWD MISSING KSFO');
  assert.deepEqual(route.unresolved, ['MISSING']);
  assert.equal(route.waypoints.length, 2);
  assert.equal(route.legs.length, 0);
});

test('chooses the ambiguous fix nearest the preceding waypoint', () => {
  const resolve = createRouteResolver([
    collection('airports', [point('airport:hwd', 'KHWD', -122.122, 37.659)]),
    collection('fixes', [
      point('fix:near', 'DUP', -122.2, 37.7),
      point('fix:far', 'DUP', -80, 26),
    ]),
  ]);

  assert.equal(resolve('KHWD DUP').waypoints[1]?.feature.id, 'fix:near');
  assert.equal(resolve('KHWD DUP', { 1: 'fix:far' }).waypoints[1]?.feature.id, 'fix:far');
});

test('expands a Victor airway and prefers its NAVAID endpoint over an airport alias', () => {
  const airwayData: AirwayDataResponse = {
    type: 'ZLayerAirways',
    metadata: { effectiveDate: '2026-09-03', source: 'test' },
    airways: [{
      id: 'airway:Y:C:V25',
      ident: 'V25',
      regulatory: true,
      points: ['SNS', 'MOVER', 'SANTY', 'OSI', 'SFO'],
      segments: [
        segment(10, 'SNS', 'VORTAC', 'MOVER'),
        segment(20, 'MOVER', 'RP', 'SANTY'),
        segment(30, 'SANTY', 'RP', 'OSI'),
        segment(40, 'OSI', 'VOR/DME', 'SFO'),
        segment(50, 'SFO', 'VOR/DME'),
      ],
    }],
  };
  const resolve = createRouteResolver([
    collection('airports', [point('airport:sfo', 'KSFO', -122.375, 37.619, 'SFO')]),
    collection('navaids', [
      point('navaid:sfo', 'SFO', -122.374, 37.62),
      point('navaid:sns', 'SNS', -121.606, 36.663),
      point('navaid:osi', 'OSI', -122.281, 37.392),
    ]),
    collection('fixes', [
      point('fix:mover', 'MOVER', -121.8, 36.9),
      point('fix:santy', 'SANTY', -122, 37.1),
    ]),
  ], airwayData);

  const route = resolve('SFO V25 SNS');
  assert.deepEqual(route.waypoints.map(({ ident }) => ident), [
    'SFO', 'OSI', 'SANTY', 'MOVER', 'SNS',
  ]);
  assert.equal(route.waypoints[0]?.feature.id, 'navaid:sfo');
  assert.deepEqual(route.waypoints.map(({ tokenIndex }) => tokenIndex), [
    0, undefined, undefined, undefined, 2,
  ]);
  assert.equal(route.airways[0]?.direction, 'reverse');
  assert.equal(route.legs.length, 4);
  assert.equal(route.legs.every((leg) => (leg.edit ? leg.from.source.tokenIndex : undefined) === undefined), true);
  assert.equal(route.legs.every((leg) => leg.owners.find(owner => owner.kind === 'airway')?.source.tokenIndex === 1), true);
  assert.deepEqual(route.issues, []);

  const forward = resolve('SNS V25 SFO');
  assert.equal(forward.waypoints.at(-1)?.feature.id, 'navaid:sfo');
  assert.ok(Math.abs(forward.distanceNm - route.distanceNm) < 0.000_001);
});

test('does not bridge an invalid airway or a missing implicit airway point', () => {
  const airwayData: AirwayDataResponse = {
    type: 'ZLayerAirways',
    metadata: { effectiveDate: '2026-09-03', source: 'test' },
    airways: [{
      id: 'airway:Y:C:T259',
      ident: 'T259',
      regulatory: true,
      points: ['SNS', 'CAATE', 'NIKOL'],
      segments: [
        segment(10, 'SNS', 'VORTAC', 'CAATE'),
        segment(20, 'CAATE', 'RP', 'NIKOL'),
        segment(30, 'NIKOL', 'RP'),
      ],
    }],
  };
  const resolve = createRouteResolver([
    collection('navaids', [point('navaid:sns', 'SNS', -121.606, 36.663)]),
    collection('fixes', [point('fix:nikol', 'NIKOL', -120.5, 38)]),
  ], airwayData);

  const missing = resolve('SNS T259 NIKOL');
  assert.equal(missing.legs.length, 0);
  assert.deepEqual(missing.unresolved, ['T259']);
  assert.equal(missing.issues[0]?.code, 'airway-point-unavailable');

  const invalid = resolve('SNS V25 NIKOL');
  assert.equal(invalid.legs.length, 0);
  assert.deepEqual(invalid.unresolved, ['V25']);
  assert.equal(invalid.issues[0]?.code, 'airway-not-found');
});

test('adds the transition fix between adjacent airways', () => {
  const airwayData: AirwayDataResponse = {
    type: 'ZLayerAirways',
    metadata: { effectiveDate: '2026-09-03', source: 'test' },
    airways: [
      {
        id: 'airway:Y:C:V25',
        ident: 'V25',
        regulatory: true,
        points: ['SNS', 'MOVER', 'SFO'],
        segments: [
          { ...segment(10, 'SNS', 'VORTAC', 'MOVER'), distanceNm: 18 },
          { ...segment(20, 'MOVER', 'RP', 'SFO'), distanceNm: 11 },
          segment(30, 'SFO', 'VOR/DME'),
        ],
      },
      {
        id: 'airway:Y:C:V150',
        ident: 'V150',
        regulatory: true,
        points: ['SFO', 'SUTRO', 'SAC'],
        segments: [
          { ...segment(10, 'SFO', 'VOR/DME', 'SUTRO'), distanceNm: 10 },
          { ...segment(20, 'SUTRO', 'RP', 'SAC'), distanceNm: 60 },
          segment(30, 'SAC', 'VORTAC'),
        ],
      },
    ],
  };
  const resolve = createRouteResolver([
    collection('navaids', [
      point('navaid:sns', 'SNS', -121.603, 36.664),
      point('navaid:sfo', 'SFO', -122.374, 37.619),
      point('navaid:sac', 'SAC', -121.552, 38.443),
    ]),
    collection('fixes', [
      point('fix:mover', 'MOVER', -121.89, 36.857),
      point('fix:sutro', 'SUTRO', -122.5, 37.8),
    ]),
  ], airwayData);

  const route = resolve('SNS V25 V150 SAC');
  assert.deepEqual(route.waypoints.map(({ ident }) => ident), [
    'SNS', 'MOVER', 'SFO', 'SUTRO', 'SAC',
  ]);
  assert.deepEqual(route.transitions, [{
    ident: 'SFO',
    beforeAirwayTokenIndex: 1,
    afterAirwayTokenIndex: 2,
  }]);
  assert.deepEqual(route.issues, []);
  assert.equal(route.legs.length, 4);
});

test('normalizes route tokens', () => {
  assert.deepEqual(routeTokensFromText(' khwd, sns > ksfo '), ['KHWD', 'SNS', 'KSFO']);
});

function collection(
  layer: NavigationLayerId,
  features: GeoPointFeature[],
): FeatureCollectionResponse {
  return {
    type: 'FeatureCollection',
    features,
    meta: { revision: '2026-09-03', layer, returned: features.length, truncated: false },
  };
}

test('airport identifiers that look like airways remain usable, including explicit map selections', () => {
  const t67 = point('airport:t67', 'T67', -97.41, 32.93, 'T67');
  const dfw = point('airport:dfw', 'KDFW', -97.04, 32.9);
  const nav = [collection('airports', [t67, dfw])];
  const resolve = createRouteResolver(nav);
  for (const input of ['T67 KDFW', 'KDFW T67', 'KDFW T67 KDFW']) {
    assert.deepEqual(resolve(input).issues, []);
  }
  assert.equal(resolve('T67 KDFW', { 0: t67.id! }).legs.length, 1);
  assert.equal(resolve('T67 KDFW', { 0: 'missing-selection' }).issues[0]?.code, 'waypoint-not-found');
  const data: AirwayDataResponse = { type: 'ZLayerAirways', metadata: { effectiveDate: '2026-09-03', source: 'test' },
    airways: [{ id: 't67', ident: 'T67', points: ['AAA', 'BBB'], segments: [segment(1, 'AAA', 'RP', 'BBB')] }] };
  const withAirways = createRouteResolver(nav, data);
  assert.equal(withAirways('T67 KDFW').legs.length, 1, 'endpoints prefer known airports');
  assert.equal(withAirways('KDFW T67 KDFW', { 1: t67.id! }).legs.length, 2, 'pins override the airway interpretation');
  assert.equal(withAirways('KDFW T67 KDFW').issues[0]?.code, 'airway-no-path', 'an interior published airway stays an airway');
});

test('missing pinned features and required airway types never fall back to other features', () => {
  const airport = point('airport:sns', 'KSNS', -121.61, 36.66, 'SNS');
  const fix = point('fix:mover', 'MOVER', -121.89, 36.85);
  const data: AirwayDataResponse = { type: 'ZLayerAirways', metadata: { effectiveDate: '2026-09-03', source: 'test' },
    airways: [{ id: 'v25', ident: 'V25', points: ['SNS', 'MOVER'],
      segments: [segment(1, 'SNS', 'VORTAC', 'MOVER'), segment(2, 'MOVER', 'RP')] }] };
  const collections = [collection('airports', [airport]), collection('fixes', [fix])];
  const resolve = createRouteResolver(collections, data);
  assert.equal(resolve('SNS V25 MOVER').legs.length, 0);
  assert.equal(resolve('SNS V25 MOVER').issues[0]?.token, 'SNS');
  assert.equal(resolve('SNS MOVER', { 0: 'missing-navaid' }).waypoints.length, 1);
  assert.equal(resolve('SNS V25 MOVER', { 0: airport.id! }).legs.length, 0);
  const wrongType = point('navaid:sns', 'SNS', -121.6, 36.6);
  wrongType.properties.type = 'NDB';
  assert.equal(createRouteResolver([...collections, collection('navaids', [wrongType])], data)
    ('SNS V25 MOVER').legs.length, 0);
});

test('direct-route words and dotted pasted routes share normalized token indexes', () => {
  const resolve = createRouteResolver([collection('airports', [
    point('sfo', 'KSFO', -122.37, 37.62), point('sjc', 'KSJC', -121.93, 37.36),
  ])]);
  for (const input of ['ksfo dct ksjc', 'KSFO DIRECT KSJC', 'KSFO..KSJC', ' KSFO, DCT > KSJC ']) {
    const plan = resolve(input, { 1: 'sjc' });
    assert.deepEqual(plan.tokens, ['KSFO', 'KSJC']);
    assert.deepEqual(plan.issues, []);
    assert.equal(plan.legs.length, 1);
    assert.equal(plan.waypoints[1]?.tokenIndex, 1);
  }
});

test('an airway-bound pin must match its published identifier even when types are absent', () => {
  const navigation = [collection('fixes', [point('fix:aaa', 'AAA', -122, 37),
    point('fix:bbb', 'BBB', -121, 37), point('fix:other', 'OTHER', -120, 37)])];
  for (const typed of [false, true]) {
    const data: AirwayDataResponse = { type: 'ZLayerAirways', metadata: { effectiveDate: '2026-09-03', source: 'test' },
      airways: [{ id: 'v1', ident: 'V1', points: ['AAA', 'BBB'], segments: [
        { sequence: 1, from: 'AAA', to: 'BBB', gap: false, ...(typed ? { fromType: 'RP' } : {}) },
        { sequence: 2, from: 'BBB', gap: false, ...(typed ? { fromType: 'RP' } : {}) },
      ] }] };
    const resolve = createRouteResolver(navigation, data);
    for (const index of [0, 2]) {
      const plan = resolve('AAA V1 BBB', { [index]: 'fix:other' });
      assert.equal(plan.legs.length, 0);
      assert.equal(plan.issues[0]?.tokenIndex, index);
    }
    assert.deepEqual(resolve('AAA V1 BBB', { 0: 'fix:aaa', 2: 'fix:bbb' }).issues, []);
  }
});

test('a shared airway waypoint must satisfy both published type constraints', () => {
  const data: AirwayDataResponse = { type: 'ZLayerAirways', metadata: { effectiveDate: '2026-09-03', source: 'test' }, airways: [
    { id: 'v1', ident: 'V1', points: ['AAA', 'DUP'], segments: [segment(1, 'AAA', 'RP', 'DUP'), segment(2, 'DUP', 'RP')] },
    { id: 'v2', ident: 'V2', points: ['DUP', 'BBB'], segments: [segment(1, 'DUP', 'VOR/DME', 'BBB'), segment(2, 'BBB', 'RP')] },
  ] };
  const resolve = createRouteResolver([
    collection('fixes', [point('fix:aaa', 'AAA', -122, 37), point('fix:dup', 'DUP', -121, 37), point('fix:bbb', 'BBB', -120, 37)]),
    collection('navaids', [point('navaid:dup', 'DUP', -121, 36)]),
  ], data);
  for (const input of ['AAA V1 V2 BBB', 'AAA V1 DUP V2 BBB']) {
    const plan = resolve(input);
    assert.ok(plan.issues.length > 0);
    assert.equal(plan.legs.length, 0, 'same spelling does not connect a fix to a different navaid');
  }
});

function point(
  id: string,
  ident: string,
  longitude: number,
  latitude: number,
  faaId?: string,
): GeoPointFeature {
  return {
    type: 'Feature',
    id,
    geometry: { type: 'Point', coordinates: [longitude, latitude] },
    properties: {
      ident,
      ...(id.startsWith('navaid:') ? { type: ['SNS', 'SAC'].includes(ident) ? 'VORTAC' : 'VOR/DME' } : {}),
      ...(id.startsWith('fix:') ? { useCode: 'RP' } : {}),
      ...(faaId ? { faaId } : {}),
      ...(ident.startsWith('K') ? { icaoId: ident } : {}),
    },
  };
}

function segment(sequence: number, from: string, fromType: string, to?: string) {
  return { sequence, from, fromType, gap: false, ...(to ? { to } : {}) };
}
