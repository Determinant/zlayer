import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isApproachRoutesData, type FeatureCollectionResponse, type TerminalProceduresData } from '@zlayer/contracts';
import { approachIdent, findApproachRoutes as legacyApproachRoutes, publishedApproachRoutes, approachEntryOptions, createRouteResolver, routeDraftFromText } from '../src/index.js';

// FAA 2609 records retained verbatim by the exporter, including distinct L/R
// constraints and helicopter/fixed-wing title collisions.
const data: unknown = JSON.parse(readFileSync(new URL('./fixtures/approach-matching.json', import.meta.url), 'utf8'));
assert.ok(isApproachRoutesData(data));
const routes = data;
const associations = JSON.parse(readFileSync(new URL('./fixtures/approach-associations.json', import.meta.url), 'utf8'));
const matches = (data: typeof routes, airport: string, name: string) => {
  const record = associations.records.find((r: { airport: string; title: string }) => r.airport === airport && r.title === name);
  return record ? publishedApproachRoutes(data, associations, record.procedureId, createHash('sha256').update(JSON.stringify(data)).digest('hex'))
    : legacyApproachRoutes(data, airport, name);
};
const match = (data: typeof routes, airport: string, name: string) => { const result = matches(data, airport, name); return result.length === 1 ? result[0] : undefined; };
const cases = [
  ['K50', 'RNAV (GPS)-A', 'RNVA'], ['KPNS', 'VOR RWY 08', 'V08'],
  ['KSMX', 'VOR RWY 12', 'V12'], ['KTBN', 'VOR RWY 33', 'V33'],
  ['KPMD', 'VOR OR TACAN Z RWY 25', 'S25'], ['KSBD', 'ILS OR LOC Z RWY 06', 'I06'],
  ['KSLE', 'ILS OR LOC Z RWY 31', 'I31'], ['PASD', 'NDB RWY 32', 'Q32'],
  ['PGSN', 'NDB Z RWY 07', 'Q07-Z'], ['PGUM', 'NDB RWY 24R', 'Q24R'], ['PTKK', 'NDB RWY 22', 'Q22'],
  ['KNOW', 'COPTER RNAV (GPS) RWY 26', 'R26'], ['KWAY', 'COPTER RNAV (GPS) Y RWY 09', 'R09-Y'],
  ['W99', 'COPTER RNAV (GPS) X RWY 31', 'R31-X'],
  ['KAST', 'COPTER LOC RWY 26', 'L26'], ['KHUM', 'COPTER VOR RWY 12', 'S12'],
  ['KEWR', 'COPTER ILS Y OR LOC Y RWY 04L', 'I04LY'], ['KMKT', 'COPTER ILS Z OR LOC Z RWY 33', 'I33-Z'],
  ['KOTH', 'COPTER ILS Y OR LOC Y RWY 05', 'I05-Y'], ['KRST', 'COPTER ILS Y OR LOC Y RWY 31', 'I31-Y'],
  ['KTEB', 'COPTER ILS Y OR LOC Y RWY 06', 'I06-Y'], ['KMSP', 'ILS RWY 35 (SA CAT I)', 'I35-Z'],
  ['KDFW', 'ILS V RWY 13R (CONVERGING)', 'I13RV'], ['KMSP', 'ILS V RWY 35 (CONVERGING)', 'I35-V'],
  ['KPHL', 'ILS V RWY 09R (CONVERGING)', 'I09RV'], ['KPHL', 'ILS V RWY 17 (CONVERGING)', 'I17-V'],
] as const;
const formats = [
  ['KDEN', 'ILS RWY 34L (SA CAT I)', 'I34L'], ['KSJT', 'VOR Y OR TACAN Y RWY 03', 'S03-Y'],
  ['KMFR', 'LOC/DME BC-B', 'LBC-B'], ['KHQU', 'ILS OR LOC/NDB RWY 10', 'I10'],
  ['PHNY', 'VOR OR TACAN OR GPS-A', 'VOR-A'], ['KSEA', 'ILS OR LOC RWY 16C, CONT.1', 'I16C'],
  ['52B', 'RNAV (GPS)-B, CONT.1', 'RNV-B'], ['87N', 'COPTER RNAV (GPS) 190', 'R190'],
  ['KJRA', 'COPTER RNAV (GPS) 210', 'R210'], ['2P2', 'COPTER RNAV (GPS) 029', 'R029'],
  ['KJFK', 'COPTER RNAV (GPS) 027', 'R027'], ['KLGA', 'COPTER RNAV (GPS) 250', 'R250'],
] as const;

test('title formats retain the actual variant, operational qualifier and approach family', () => {
  for (const [airport, name, ident] of formats) {
    assert.equal(approachIdent(name), ident, name);
    assert.equal(match(routes, airport, name)?.id, `${airport}:${ident}`, name);
  }
  for (const name of ['VOR Z OR TACAN Y RWY 03', 'VOR Y OR GPS Z RWY 03', 'HI-ILS RWY 34L',
    'ILS RWY 34L (CAT II)', 'ILS RWY 34L (SA CAT II)', 'ILS RWY 34L (SA CAT I - II)',
    'ILS PRM RWY 34L', 'ILS RWY 34L (CONVERGING)', 'RNAV (GPS) RWY 190', 'COPTER RNAV (GPS) 999']) {
    assert.equal(approachIdent(name), undefined, name);
  }
});

test('published reviewed associations expire with their data edition and never apply to a different variant or airport', () => {
  const future = structuredClone(routes);
  future.metadata.effectiveDate = '2026-10-01';
  for (const [airport, name, ident] of cases) {
    assert.equal(match(routes, airport, name)?.id, `${airport}:${ident}`, `${airport} ${name}`);
    assert.equal(match(future, airport, name), undefined, `new edition: ${airport} ${name}`);
    assert.equal(match(routes, 'KXXX', name), undefined);
  }
  assert.equal(match(routes, 'KSBD', 'ILS OR LOC Y RWY 06'), undefined);
  assert.equal(match(routes, 'KHGR', 'COPTER RNAV (GPS) RWY 09'), undefined);
  assert.equal(match(routes, 'KHGR', 'COPTER RNAV (GPS) RWY 27'), undefined);
  assert.equal(match(routes, 'KACY', 'COPTER ILS OR LOC/DME RWY 13'), undefined);
  assert.equal(match(routes, 'KEWR', 'COPTER ILS/DME RWY 22L'), undefined);
  assert.equal(match(routes, 'KHGR', 'RNAV (GPS) RWY 09')?.id, 'KHGR:R09');
  assert.equal(match(routes, 'KDFW', 'ILS RWY 18L (CONVERGING)'), undefined);
  const missing = structuredClone(routes);
  missing.procedures = missing.procedures.filter(p => p.id !== 'KDFW:I13RV');
  assert.equal(match(missing, 'KDFW', 'ILS V RWY 13R (CONVERGING)'), undefined, 'ordinary Z variant cannot substitute');
});

test('shared runway charts require both complete source routes to agree, including altitude constraints', () => {
  assert.equal(match(routes, 'KJFK', 'VOR OR GPS RWY 13L/R')?.id, 'KJFK:S13L');
  assert.equal(match(routes, 'KLAS', 'VOR RWY 26L/R')?.id, 'KLAS:S26L');
  assert.equal(match(routes, 'KBJC', 'VOR/DME RWY 30L/R'), undefined, 'BJC routes differ in altitude');
  assert.deepEqual(matches(routes, 'KBJC', 'VOR/DME RWY 30L/R').map(p => p.id), ['KBJC:D30L', 'KBJC:D30R']);
  const changed = structuredClone(routes);
  changed.procedures.find(p => p.id === 'KJFK:S13R')!.final[0]!.altitude!.first = '04000';
  assert.equal(match(changed, 'KJFK', 'VOR OR GPS RWY 13L/R'), undefined);
  changed.procedures = changed.procedures.filter(p => p.id !== 'KLAS:S26R');
  assert.equal(match(changed, 'KLAS', 'VOR RWY 26L/R'), undefined);
});

test('picker associations survive serialization and route expansion without losing the original chart title', () => {
  const terminal: TerminalProceduresData = { type: 'ZLayerTerminalProcedures', metadata: {
    effectiveDate: routes.metadata.effectiveDate, source: routes.metadata.source,
  }, procedures: [], approaches: routes };
  for (const [airport, name, ident] of [...cases, ...formats, ['KJFK', 'VOR OR GPS RWY 13L/R', 'S13L'],
    ['KBJC', 'VOR/DME RWY 30L/R', 'D30L'], ['KBJC', 'VOR/DME RWY 30L/R', 'D30R']]) {
    const p = matches(routes, airport!, name!).find(p => p.ident === ident)!, entry = approachEntryOptions(p)[0]!;
    const collection: FeatureCollectionResponse = { type: 'FeatureCollection', meta: {
      layer: 'airports', revision: routes.metadata.effectiveDate, returned: 1, truncated: false,
    }, features: [{ type: 'Feature', id: airport!, properties: { ident: airport! }, geometry: {
      type: 'Point', coordinates: p.final.find(l => l.fix)!.fix!.coordinate,
    } }] };
    const base = routeDraftFromText(airport!);
    const approach = { kind: 'approach' as const, source: 'chart' as const, airportId: airport!, procedureId: 'original-chart', name: name!, cycle: '2609', entry: {
      routeId: `${airport}:${ident}`, transitionId: entry.id, name: entry.name, effectiveDate: routes.metadata.effectiveDate,
    } };
    const draft = { ...base, entries: [{ ...base.entries[0]!, approach }] };
    const resolve = createRouteResolver([collection], undefined, terminal);
    const plan = resolve(JSON.parse(JSON.stringify(draft)));
    assert.ok(!plan.issues.some(i => i.code === 'approach-unavailable'), `${airport} ${name}`);
    assert.ok(plan.waypoints.some(p => p.approachPhase === 'missed'), `${airport} ${name} missed fixes`);
    assert.equal(plan.entries[0]!.approach!.name, name);
    const stale = { ...draft, entries: [{ ...draft.entries[0]!, approach: { ...approach,
      entry: { ...approach.entry, routeId: 'another-procedure' } } }] };
    assert.ok(resolve(stale).issues.some(i => i.code === 'approach-unavailable'), 'saved route ID must still agree');
  }
});
