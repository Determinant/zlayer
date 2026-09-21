import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { isTerminalProceduresData, type ApproachRoute, type FeatureCollectionResponse } from '@zlayer/contracts';
import { approachPreview, createRouteResolver, routeDraftFromText, updateApproachHoldEntries, type RouteApproach } from '@zlayer/domain';
import { setRouteApproach } from '../src/layers/routes/draft';

test('route and preview hold entries follow the arriving route, with no default when it is absent', () => {
  const terminal: unknown = JSON.parse(readFileSync(new URL('./fixtures/route-approach-published.json', import.meta.url), 'utf8')).terminal;
  assert.ok(isTerminalProceduresData(terminal));
  const procedure = terminal.approaches!.procedures.find(p => p.id === 'KSNS:I31')!;
  const fix = procedure.transitions[0]!.legs.at(-1)!.fix!;
  const selected: RouteApproach = { airportId: 'KSNS', procedureId: 'ils31', name: 'ILS RWY 31', cycle: '2609',
    entry: { routeId: procedure.id, transitionId: 'transition-fix:SNS1:2', name: 'AANNE', effectiveDate: '2026-09-03' } };
  const { entry: _entry, ...legacy } = selected;
  const previousApproaches: (RouteApproach | undefined)[] = [undefined, selected,
    { ...selected, entry: { ...selected.entry!, transitionId: 'vectors', name: 'VTF' } }, legacy];
  for (const [dx, dy, entry] of [[-.1, -.1, 'Direct'], [.1, .1, 'Parallel'], [-.1, .1, 'Teardrop']] as const) {
    const origin: [number, number] = [fix.coordinate[0] + dx, fix.coordinate[1] + dy];
    const airports: FeatureCollectionResponse = { type: 'FeatureCollection', meta: { layer: 'airports', revision: '2026-09-03', returned: 3, truncated: false },
      features: [['ORIGIN', origin], ['AANNE', fix.coordinate], ['KSNS', [-121.606, 36.663]]].map(([ident, coordinate]) => ({
        type: 'Feature', id: String(ident), properties: { ident: String(ident) }, geometry: { type: 'Point', coordinates: coordinate as [number, number] },
      })) };
    const resolve = createRouteResolver([airports], undefined, terminal);
    for (const text of ['ORIGIN KSNS', 'ORIGIN AANNE KSNS']) {
      const draft = routeDraftFromText(text), plan = resolve(setRouteApproach(draft, draft.entries.at(-1)!, selected));
      const hold = plan.waypoints.find(p => p.ident === 'AANNE' && p.approachHold)!;
      assert.equal(hold.approachHold!.entry, entry);
      assert.ok(hold.approachRole!.includes(`HOLD R · ${entry.toUpperCase()}`));
      assert.equal(plan.waypoints.find(p => p.ident === 'MARNA')!.approachHold!.entry, 'Parallel');
      for (const previous of previousApproaches) {
        const current = resolve(setRouteApproach(draft, draft.entries.at(-1)!, previous));
        const single = routeDraftFromText('KSNS'), preview = resolve(setRouteApproach(single, single.entries[0]!, selected));
        updateApproachHoldEntries(preview, current.waypoints.find(p => p.ident === 'KSNS')!.approachArrival);
        assert.equal(preview.waypoints[0]!.approachHold!.entry, entry,
          `preview from ${previous?.entry?.name ?? 'unselected'} retains the ${text} arrival`);
      }
    }
    const draft = routeDraftFromText('KSNS'), preview = resolve(setRouteApproach(draft, draft.entries[0]!, selected));
    const hold = preview.waypoints.find(p => p.ident === 'AANNE')!;
    assert.equal(hold.approachHold!.entry, undefined);
    updateApproachHoldEntries(preview, { coordinate: origin });
    assert.equal(hold.approachHold!.entry, entry);
    updateApproachHoldEntries(preview);
    assert.equal(hold.approachHold!.entry, undefined, 'changing the preview context clears the previous suggestion');
    assert.ok(hold.approachRole!.includes('HOLD R · ENTRY ?'));
    const gap = routeDraftFromText('ORIGIN AANNE UNKNOWN KSNS');
    const disconnected = resolve(setRouteApproach(gap, gap.entries.at(-1)!, selected));
    const arrival = disconnected.waypoints.find(p => p.ident === 'KSNS')!.approachArrival;
    assert.equal(arrival, undefined, 'preview context cannot bridge an unresolved route item');
    updateApproachHoldEntries(preview, arrival);
    assert.equal(hold.approachHold!.entry, undefined);
  }
});

test('an arc arrival uses the endpoint tangent and a discontinuity does not supply a course', () => {
  const procedure: ApproachRoute = { id: 'TEST:R01', airport: 'TEST', ident: 'R01', transitions: [], final: [
    { path: 'IF', fix: { ident: 'START', coordinate: [0, .1], role: 'IAF' } },
    { path: 'RF', fix: { ident: 'HOLD', coordinate: [.1, 0] }, center: [0, 0], turn: 'R' },
    { path: 'HM', fix: { ident: 'HOLD', coordinate: [.1, 0] }, trueCourse: 0, turn: 'R', holdMinutes: 1 },
  ] };
  assert.equal(approachPreview(procedure, 'final:0')!.points[1]!.arrivalCourse, 180);
  procedure.final[1] = { path: 'VM' };
  assert.equal(approachPreview(procedure, 'final:0')!.points[1]!.arrivalCourse, undefined);
});
