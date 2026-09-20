import assert from 'node:assert/strict';
import test from 'node:test';
import type { FeatureCollectionResponse, GeoPointFeature } from '@zlayer/contracts';
import {
  airportIdentifiers, airportRouteIdent, createRouteResolver, featureIdent, featureIdentifiers,
  featureKey, isAirportFeature, routeCoordinateFeature, routeTokenForFeature, sameFeature, searchNavigation,
} from '../src/index.js';

const point = (properties: GeoPointFeature['properties'], coordinates: [number, number] = [-122, 37]): GeoPointFeature =>
  ({ type: 'Feature', properties, geometry: { type: 'Point', coordinates } });

test('published IDs survive enrichment and map rounding across all navigation kinds', () => {
  for (const kind of ['airport', 'landing-facility', 'navaid', 'fix', 'vfr-waypoint']) {
    const original = { ...point({ kind, ident: 'SNS' }), id: `${kind}:SNS` };
    const enriched = { ...point({ kind, ident: 'SNS', name: 'SALINAS', flightCategory: 'VFR',
      dataRevision: 'another-edition' }, [-122.0001, 37.0001]), id: original.id };
    assert.equal(featureKey(original), original.id);
    assert.equal(featureKey(enriched), featureKey(original));
    assert.ok(sameFeature(original, enriched));
    assert.ok(!sameFeature(original, { ...enriched, id: `${kind}:other` }));
    assert.ok(!sameFeature(original, point(original.properties)));
  }
});

test('ID-less features retain their kind, identifier and location distinctions', () => {
  const original = point({ kind: 'fix', ident: 'DUP' });
  const copy = point({ kind: 'fix', ident: 'DUP', name: 'Different display text' });
  assert.ok(sameFeature(original, copy));
  for (const other of [
    point({ kind: 'fix', ident: 'DUP' }, [-121, 37]),
    point({ kind: 'fix', ident: 'OTHER' }),
    point({ kind: 'navaid', ident: 'DUP' }),
  ]) {
    assert.ok(!sameFeature(original, other));
    assert.notEqual(featureKey(original), featureKey(other));
  }
  assert.ok(sameFeature(point({ kind: 'airport', icaoId: 'KSNS' }),
    point({ kind: 'landing-facility', icaoId: 'KSNS' })));
});

test('identity serialization does not change route resolution tie-breaks for ID-less candidates', () => {
  const first = point({ kind: 'fix', ident: 'DUP' }, [-122, 37]);
  const second = point({ kind: 'fix', ident: 'DUP' }, [-122, 37.1]);
  for (const features of [[first, second], [second, first]]) {
    const collection: FeatureCollectionResponse = { type: 'FeatureCollection', features,
      meta: { revision: 'test', layer: 'fixes', returned: 2, truncated: false } };
    assert.equal(createRouteResolver([collection])('DUP').waypoints[0]?.feature, first);
  }
});

test('GPS identity uses its coordinate token through map rounding and dragging', () => {
  const gps = routeCoordinateFeature([-122, 37]);
  const rendered = { ...gps, geometry: { type: 'Point' as const, coordinates: [-122.0001, 37.0001] as [number, number] } };
  assert.equal(featureKey(gps), featureKey(rendered));
  assert.ok(sameFeature(gps, rendered));
  assert.ok(!sameFeature(gps, routeCoordinateFeature([-121, 37])));
  assert.ok(!sameFeature(gps, point({ kind: 'fix', ident: gps.properties.ident! })));
});

test('display, search and routing share ordered aliases and skip blank identifiers', () => {
  const airport = { ...point({ kind: 'airport', icaoId: ' ksns ', faaId: ' sns ', ident: 'SNS', name: 'Salinas' }), id: 'airport:SNS' };
  const collection: FeatureCollectionResponse = { type: 'FeatureCollection', features: [airport],
    meta: { revision: 'test', layer: 'airports', returned: 1, truncated: false } };
  assert.deepEqual(featureIdentifiers(airport), ['KSNS', 'SNS']);
  assert.deepEqual(airportIdentifiers(airport), ['KSNS', 'SNS']);
  assert.equal(featureIdent(airport), 'KSNS');
  assert.equal(airportRouteIdent(airport), 'KSNS');
  assert.equal(routeTokenForFeature(airport), 'KSNS');
  for (const alias of ['ksns', 'sns']) {
    assert.equal(searchNavigation([collection], alias)[0]?.score, 100);
    assert.equal(createRouteResolver([collection])(alias).waypoints[0]?.feature, airport);
  }
  const blank = point({ icaoId: ' ', faaId: '', ident: ' sns ' });
  assert.deepEqual(featureIdentifiers(blank), ['SNS']);
  assert.deepEqual(airportIdentifiers(blank), [], 'generic identifiers are not airport service aliases');
  assert.equal(featureIdent(blank), 'SNS');
  assert.equal(routeTokenForFeature(blank), 'SNS');
});

test('display names and reserved or delimited identifiers never become route tokens', () => {
  const named = point({ name: 'A display name' });
  assert.equal(featureIdent(named), 'A display name');
  assert.equal(routeTokenForFeature(named), '');
  for (const icaoId of ['DCT', 'DIRECT', 'TWO WORDS', 'A-B', 'A/B']) {
    const feature = point({ icaoId, ident: 'FIX' });
    assert.equal(featureIdent(feature), icaoId);
    assert.equal(routeTokenForFeature(feature), 'FIX');
  }
});

test('airport classification recognizes both airport kinds without inferring type from an identifier', () => {
  for (const kind of ['airport', 'landing-facility', 'navaid', 'fix', 'vfr-waypoint', 'coordinate', undefined]) {
    const feature = point({ ...(kind ? { kind } : {}), icaoId: 'KSNS', faaId: 'SNS' });
    assert.equal(isAirportFeature(feature), kind === 'airport' || kind === 'landing-facility');
  }
});
