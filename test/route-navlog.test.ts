import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { isTerminalProceduresData, type FeatureCollectionResponse } from '@zlayer/contracts';
import { createRouteResolver, routeDraftFromText } from '@zlayer/domain';
import { isMagneticModel } from '../src/core/geo/magnetic-model';
import { navLogRows } from '../src/layers/routes/navlog-rows';
import { setRouteApproach } from '../src/layers/routes/draft';

const resolve = createRouteResolver([]);
const time = Date.UTC(2026, 8, 21);
const model: unknown = JSON.parse(readFileSync(new URL('./fixtures/magnetic-model.json', import.meta.url), 'utf8'));
assert.ok(isMagneticModel(model));

test('NavLog preserves repeated occurrences, inbound leg distances and unrounded cumulative totals', () => {
  const plan = resolve('000000N0000000E 000000N0010000E 000000N0000000E');
  const { rows, incomplete } = navLogRows(plan, null, time);
  assert.equal(incomplete, false);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(row => row.course), ['—', '— / 090°T', '— / 270°T']);
  assert.deepEqual(rows.map(row => row.distanceNm), [null, plan.legs[0]!.distanceNm, plan.legs[1]!.distanceNm]);
  assert.equal(rows.at(-1)!.totalNm, plan.distanceNm);
  assert.equal(rows[0]!.totalNm, 0);
  assert.ok(Math.abs(rows[1]!.totalNm - 60.04046) < .00001);
});

test('NavLog retains gaps and never measures across unresolved route text', () => {
  const plan = resolve('000000N0000000E UNKNOWN 000000N0010000E 000000N0020000E');
  const { rows, incomplete } = navLogRows(plan, null, time);
  assert.equal(incomplete, true);
  assert.equal(rows[1]!.gap, 'Unmeasured segment');
  assert.equal(rows[1]!.course, '—');
  assert.equal(rows[1]!.distanceNm, null);
  assert.equal(rows[1]!.totalNm, 0);
  assert.equal(rows.at(-1)!.totalNm, plan.distanceNm);
  assert.equal(navLogRows(resolve('UNKNOWN'), null).incomplete, true);
  assert.deepEqual(navLogRows(resolve(''), null).rows, []);
});

test('NavLog shows magnetic / true courses and retains true course without a magnetic reference', () => {
  // NOAA WMM fixture: a California eastbound leg has east declination, reducing magnetic course.
  const plan = resolve('370000N1220000W 370000N1210000W');
  assert.match(navLogRows(plan, model, time).rows[1]!.course, /^07\d°M \/ 090°T$/);
  assert.equal(navLogRows(plan, null, time).rows[1]!.course, '— / 090°T');
  assert.equal(navLogRows(plan, model, Date.UTC(2030, 0, 1)).rows[1]!.course, '— / 090°T');
  assert.equal(navLogRows(resolve('000000N0000000E 000000N0000000E'), model, time).rows[1]!.course, '—');
  assert.equal(navLogRows(resolve('000000N0000000E 000000N1800000E'), model, time).rows[1]!.course, '—');
});

const terminal: unknown = JSON.parse(readFileSync(new URL('./fixtures/route-approach-legs.json', import.meta.url), 'utf8'));
assert.ok(isTerminalProceduresData(terminal));
const airports: FeatureCollectionResponse = { type: 'FeatureCollection',
  meta: { layer: 'airports', revision: '2026-09-03', returned: 1, truncated: false },
  features: [{ type: 'Feature', id: 'KSFO', properties: { ident: 'KSFO' },
    geometry: { type: 'Point', coordinates: [-122.375, 37.619] } }],
};

for (const transitionId of ['transition:ARCHI', 'vectors']) test(`NavLog follows approach occurrences and separates missed legs (${transitionId})`, () => {
  const route = routeDraftFromText('370000N1220000W KSFO 380000N1220000W');
  const draft = setRouteApproach(route, route.entries[1]!, { kind: 'approach' as const, source: 'chart' as const,
    airportId: 'KSFO', procedureId: 'ils', name: 'ILS OR LOC RWY 28R', cycle: '2609',
    entry: { routeId: 'KSFO:I28R', transitionId, name: transitionId, effectiveDate: '2026-09-03' },
  });
  const plan = createRouteResolver([airports], undefined, terminal)(draft);
  const { rows } = navLogRows(plan, null, time);
  assert.ok(rows.some(row => row.waypoint.ident === 'RW28R'));
  assert.ok(rows.some(row => row.section.startsWith('Missed approach')));
  assert.ok(rows.some(row => row.waypoint.approachHold));
  assert.ok(!rows.some(row => row.waypoint.ident === 'KSFO'), 'the editable airport marker is not a leg after the missed hold');
  assert.ok(Math.abs(rows.at(-1)!.totalNm - plan.distanceNm) < 1e-10);
  if (transitionId === 'vectors') {
    const entry = rows.find(row => row.waypoint.approachPhase)!;
    assert.match(entry.gap, /Vectors to final/);
    assert.equal(entry.distanceNm, null);
  }
});

test('NavLog counts the published arc geometry and avoids presenting its chord as the course', () => {
  const data = structuredClone(terminal);
  const procedure = data.approaches!.procedures.find(item => item.id === 'KSFO:I28R')!;
  procedure.final = [
    { path: 'IF', fix: { ident: 'START', role: 'IAF', coordinate: [0, .1] } },
    { path: 'RF', fix: { ident: 'END', coordinate: [.1, 0] }, center: [0, 0], turn: 'R' },
  ];
  procedure.transitions = [];
  const route = routeDraftFromText('KSFO');
  const draft = setRouteApproach(route, route.entries[0]!, { kind: 'approach' as const, source: 'chart' as const,
    airportId: 'KSFO', procedureId: 'arc', name: 'ILS OR LOC RWY 28R', cycle: '2609',
    entry: { routeId: procedure.id, transitionId: 'final:0', name: 'START', effectiveDate: '2026-09-03' },
  });
  const plan = createRouteResolver([airports], undefined, data)(draft);
  assert.ok(plan.legs[0]!.geometry!.length > 2);
  const { rows } = navLogRows(plan, null, time);
  assert.equal(rows[1]!.course, 'Varies');
  assert.equal(rows[1]!.distanceNm, plan.legs[0]!.distanceNm);
  assert.ok(rows[1]!.distanceNm! > 9.4, 'quarter-circle length exceeds its 8.49 NM chord');
  assert.equal(rows[1]!.totalNm, plan.distanceNm);
});
