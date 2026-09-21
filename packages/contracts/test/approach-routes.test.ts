import assert from 'node:assert/strict';
import test from 'node:test';
import { isApproachRoutesData, type ApproachRoutesData } from '../src/approach-routes.js';

const data: ApproachRoutesData = { type: 'ZLayerApproachRoutes', metadata: { effectiveDate: '2026-09-03', source: 'FAA', schemaVersion: 2 },
  procedures: [{ id: 'TEST:S01', airport: 'TEST', ident: 'S01', transitions: [], final: [{ path: 'CD', id: 'S::010',
    waypointDescriptor: '  M ', reference: { id: 'D:K2:ABC:', ident: 'ABC', type: 'navaid', coordinate: [-120, 38], dmeCoordinate: [-120.1, 38.1], declination: -14 },
    radial: 90, rhoNm: 0, distance: 1.5, altitude: { restriction: '+', first: '-0010', second: 'FL180' } }] }], unavailable: [] };
test('reference metadata, constraints and unavailable branches validate without breaking legacy editions', () => {
  assert.ok(isApproachRoutesData(data));
  const legacy = structuredClone(data); delete legacy.metadata.schemaVersion; delete legacy.unavailable;
  legacy.procedures[0]!.final = [{ path: 'CA', magneticCourse: 90 }];
  assert.ok(isApproachRoutesData(legacy));
  const unavailable = structuredClone(data);
  unavailable.unavailable = [{ id: 'TEST:S02', airport: 'TEST', ident: 'S02', reason: 'multiple-main-branches',
    branches: [{ id: 'S:', legs: data.procedures[0]!.final }, { id: 'Z:', legs: data.procedures[0]!.final }] }];
  assert.ok(isApproachRoutesData(unavailable));
  for (const change of [
    { reference: { id: 'D:K2:ABC:', ident: 'ABC', type: 'navaid', declination: Infinity } },
    { reference: { id: 'D:K2:ABC:', ident: 'ABC', type: 'navaid', dmeCoordinate: [181, 0] } },
    { radial: 360 }, { rhoNm: -1 }, { altitude: { restriction: '+', first: '1000', second: '' } }, { waypointDescriptor: 'M' },
  ]) {
    const invalid = structuredClone(data); Object.assign(invalid.procedures[0]!.final[0]!, change);
    assert.equal(isApproachRoutesData(invalid), false);
  }
  const unresolved = structuredClone(data);
  unresolved.procedures[0]!.final[0]!.reference = { id: 'D:K2:ABC:', ident: 'ABC', type: 'navaid' };
  assert.ok(isApproachRoutesData(unresolved), 'retain identity when source position is missing');
});
