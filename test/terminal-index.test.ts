import assert from 'node:assert/strict';
import test from 'node:test';
import { isTerminalProceduresData, type FeatureCollectionResponse } from '@zlayer/contracts';
import { codedTerminalSelection, createRouteResolver, terminalPaths } from '@zlayer/domain';
import fixture from './fixtures/coded-terminal-procedures.json';

test('airport previews inspect selected branches only; saved synthetic pins retain exact source membership', () => {
  const data: unknown = structuredClone(fixture);
  assert.ok(isTerminalProceduresData(data));
  const reads = new Map<string, number>();
  for (const procedure of data.codedProcedures!.procedures) for (const branch of procedure.branches) {
    const legs = branch.legs;
    Object.defineProperty(branch, 'legs', { get() { reads.set(procedure.airport, (reads.get(procedure.airport) ?? 0) + 1); return legs; } });
  }
  const airports: FeatureCollectionResponse = { type: 'FeatureCollection', meta: {
    layer: 'airports', revision: data.metadata.effectiveDate, returned: 1, truncated: false,
  }, features: [{ type: 'Feature', id: 'KSJC', properties: { ident: 'KSJC' }, geometry: { type: 'Point', coordinates: [-121.929, 37.362] } }] };
  const resolve = createRouteResolver([airports], undefined, data);
  assert.equal(reads.size, 0, 'resolver construction must not walk national terminal legs');
  const procedure = data.codedProcedures!.procedures.find(p => p.airport === 'KSJC')!;
  const selection = codedTerminalSelection(procedure, terminalPaths(procedure)[0]!, data.metadata.effectiveDate);
  assert.equal(selection.kind, 'departure');
  const plan = resolve({ entries: [{ id: 'airport', text: 'KSJC', ...(selection.kind === 'departure' ? { departure: selection } : {}) }] });
  assert.deepEqual([...reads.keys()], ['KSJC'], 'a preview must not prepare other airports');
  const child = plan.waypoints.find(p => p.owners.length && p.feature.id?.startsWith('approach-fix:'))!;
  assert.ok(child);
  const pinned = { entries: [{ id: 'saved-fix', text: child.ident, pinnedFeatureId: child.feature.id! }] };
  assert.equal(createRouteResolver([], undefined, data)(pinned).waypoints[0]!.ident, child.ident);
  const firstLookup = [...reads];
  assert.equal(createRouteResolver([], undefined, data)(pinned).waypoints[0]!.ident, child.ident);
  assert.deepEqual([...reads], firstLookup, 'saved-pin membership is indexed once per document');
  const missing = { entries: [{ ...pinned.entries[0]!, pinnedFeatureId: `approach-fix:${JSON.stringify([child.ident, 0, 0])}` }] };
  assert.equal(createRouteResolver([], undefined, data)(missing).waypoints.length, 0, 'a matching name cannot authorize other coordinates');
});
