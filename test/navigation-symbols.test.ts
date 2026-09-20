import assert from 'node:assert/strict';
import test from 'node:test';
import { createExpression } from '@maplibre/maplibre-gl-style-spec';
import { FIX_ICON_IMAGE, NAVAID_ICON_IMAGE, NAVIGATION_ICON_IDS } from '../src/layers/navigation/symbols';

test('FAA waypoint types and RNAV charting remarks select stars, including RNAV reporting points', () => {
  const compiled = createExpression(FIX_ICON_IMAGE, 'layers[0].layout.icon-image');
  assert.equal(compiled.result, 'success');
  if (compiled.result !== 'success') throw new Error('Invalid fix icon expression');
  const icon = (properties: Record<string, unknown>) => {
    const result = compiled.value.evaluate({ zoom: 10 }, { type: 'Point', properties });
    assert.ok(NAVIGATION_ICON_IDS.includes(result));
    return result;
  };
  for (const useCode of ['WP', 'MW', 'NRS', 'wp']) {
    assert.equal(icon({ useCode }), 'fix-rnav', useCode);
  }
  for (const useCode of ['RP', 'MR']) {
    for (const chartingRemark of ['RNAV', 'COMPULSORY RNAV', 'RNAV COMPULSORY HIGH', 'compulsory low rnav']) {
      assert.equal(icon({ useCode, chartingRemark }), 'fix-rnav', `${useCode}: ${chartingRemark}`);
    }
    assert.equal(icon({ useCode }), 'fix-triangle');
    assert.equal(icon({ useCode, chartingRemark: 'COMPULSORY HIGH' }), 'fix-triangle');
  }
  assert.equal(icon({ chartingRemark: 'RNAV' }), 'fix-rnav');
  assert.equal(icon({}), 'fix-triangle');
  // A route name, a five-letter identifier, or use on an IAP does not establish RNAV type.
  assert.equal(icon({ ident: 'RNAVX', charts: ['IAP'], airway: 'T1' }), 'fix-triangle');
});

test('navaid style expressions retain canonical and compact subtype symbols', () => {
  const compiled = createExpression(NAVAID_ICON_IMAGE, 'layers[0].layout.icon-image');
  assert.equal(compiled.result, 'success');
  if (compiled.result !== 'success') throw new Error('Invalid navaid icon expression');
  const icon = (type?: string) => compiled.value.evaluate({ zoom: 10 }, { type: 'Point', properties: { type } });
  for (const type of ['VOR/DME', 'VORDME', 'VOR-DME', 'vordme']) assert.equal(icon(type), 'navaid-vor-dme');
  for (const type of ['NDB/DME', 'NDBDME', 'NDB-DME', 'ndbdme']) assert.equal(icon(type), 'navaid-ndb-dme');
  for (const [type, expected] of [['VOR', 'vor'], ['VORTAC', 'vortac'], ['DME', 'dme'],
    ['TACAN', 'tacan'], ['NDB', 'ndb'], ['MARINE NDB', 'ndb']]) {
    assert.equal(icon(type), `navaid-${expected}`);
  }
  for (const type of ['VOT', 'VOR--DME', 'UNKNOWN', undefined]) assert.equal(icon(type), 'navaid-generic');
});
