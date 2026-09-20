import assert from 'node:assert/strict';
import test from 'node:test';
import { createRouteResolver, parseRouteCoordinate, restoreRouteCoordinate, routeCoordinateFeature, routeDraftFromText,
  routeDraftText, routeTokensFromText } from '../src/index.js';

test('GPS coordinates round to seconds, carry minutes/degrees, and wrap map world copies', () => {
  for (const [coordinate, token] of [
    [[-122.5, 37.25], '371500N1223000W'],
    [[122.5, -37.25], '371500S1223000E'],
    [[237.5, 37.25], '371500N1223000W'],
    [[-482.5, 37.25], '371500N1223000W'],
    [[-122.999999, 37.999999], '380000N1230000W'],
    [[0, 0], '000000N0000000E'],
    [[180, 90], '900000N1800000W'],
  ] as const) {
    const feature = routeCoordinateFeature([...coordinate]);
    assert.equal(feature.properties.ident, token);
    assert.deepEqual(parseRouteCoordinate(token), feature);
    assert.deepEqual(routeTokensFromText(`DCT ${token.toLowerCase()}`), [token]);
    assert.equal(feature.id, undefined, 'coordinates must not create unresolved navigation pins');
  }
  for (const coordinate of [[NaN, 0], [0, Infinity], [0, 90.00001]] as const) {
    assert.throws(() => routeCoordinateFeature([...coordinate]), RangeError);
  }
});

test('coordinate routes resolve and remain editable without any navigation collections', () => {
  const resolve = createRouteResolver([]);
  const draft = routeDraftFromText('371500N1223000W 380000N1230000W 390000N1240000W');
  for (const plan of [resolve(draft), resolve(routeDraftText(draft))]) {
    assert.deepEqual(plan.issues, []);
    assert.deepEqual(plan.waypoints.map(point => point.feature.geometry.coordinates), [
      [-122.5, 37.25], [-123, 38], [-124, 39],
    ]);
    assert.equal(plan.legs.length, 2);
    assert.ok(plan.distanceNm > 100);
    assert.ok(plan.waypoints.every(point => point.edit?.kind === 'waypoint'));
    assert.ok(plan.legs.every(leg => leg.edit?.kind === 'leg'));
  }
  const pinned = resolve('371500N1223000W', { 0: 'missing-feature' });
  assert.equal(pinned.waypoints.length, 0, 'missing explicit pins never fall back to coordinates');
});

test('saved GPS selections recover their encoded coordinates without changing navigation features', () => {
  const feature = parseRouteCoordinate('350000N1190535W')!;
  for (const coordinates of [[-119.091796875, 34.99850370014629], [feature.geometry.coordinates[0] + 360, 35]]) {
    const saved = JSON.parse(JSON.stringify({ ...feature, geometry: { type: 'Point', coordinates } }));
    assert.deepEqual(restoreRouteCoordinate(saved), feature);
    assert.deepEqual(saved.geometry.coordinates, coordinates, 'restoration does not mutate the saved feature');
  }
  assert.equal(restoreRouteCoordinate(feature), feature);
  const named = { ...feature, properties: { kind: 'fix', ident: feature.properties.ident! } };
  assert.equal(restoreRouteCoordinate(named), named);
  const invalid = { ...feature, properties: { kind: 'coordinate', ident: 'invalid' } };
  assert.equal(restoreRouteCoordinate(invalid), invalid);
});

test('invalid coordinates remain unresolved and break route connectivity', () => {
  for (const token of ['910000N1220000W', '900001N1220000W', '370000N1810000W',
    '376000N1220000W', '370060N1220000W', '370000N1226000W', '370000N1220060W',
    '370000X1220000W']) {
    assert.equal(parseRouteCoordinate(token), undefined);
    const plan = createRouteResolver([])(`371500N1223000W ${token} 380000N1230000W`);
    assert.deepEqual(plan.unresolved, [token]);
    assert.equal(plan.legs.length, 0);
  }
});
