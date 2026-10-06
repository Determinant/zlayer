import assert from 'node:assert/strict';
import test from 'node:test';
import type { NotamRecord } from '@zlayer/contracts';
import corpus from './fixtures/notams-semantic.json' with { type: 'json' };
import { notice } from './fixtures/notams';
import { parseNotam } from '../src/layers/notams/parser';
import { presentNotam } from '../src/layers/notams/presentation';
import { chartedNotamPresentation } from '../src/layers/notams/chart';
import { notamObstacles, notamObstacleFeatures } from '../src/layers/notams/obstacles';
import { auditMappedNotam, auditNotam, auditRenderedNotam } from '../tools/audit-notams';
import { takeoffMinimumsGroup } from '../src/layers/notams/takeoff';
import { auditValueBindings } from '../tools/notam-value-audit';
import { assessNotamGenerations, type CaptureEvidence } from '../tools/audit-notam-generations';

test('captured obstacle, airport, facility, airspace and procedure families retain independently reviewed facts', () => {
  for (const { record: raw, expected, airport } of corpus.cases) {
    const record=raw as NotamRecord, parsed=parseNotam(record), context=`${airport} ${record.id}`;
    assert.equal(parsed.subject,expected.subject,context);
    for (const label of expected.facts ?? []) assert.ok(parsed.facts.some(f=>f.label===label),`${context}: ${label}`);
    for (const label of expected.forbidden ?? []) assert.ok(!parsed.facts.some(f=>f.label===label),`${context}: false ${label}`);
    const mapped=chartedNotamPresentation(record);
    assert.equal(!!mapped,expected.mapped,context);
    const text=(mapped?.presentation ?? presentNotam(record)).searchText.toUpperCase();
    for (const phrase of expected.retained ?? []) assert.ok(text.includes(phrase),`${context}: ${phrase}`);
    if (expected.label) assert.ok(notamObstacleFeatures([record],record.startsAt!).features[0]!.properties.label.startsWith(expected.label));
    assert.deepEqual(auditNotam(record),[],context);
    assert.deepEqual(auditMappedNotam(record),[],context);
    assert.deepEqual(auditRenderedNotam(record,true),[],context);
  }
});

const point='OBST CRANE LGT (ASN 2026-AWP-1-OE) 370000N1220000W (.2NM S TST) 500FT (200FT AGL)';
test('mapping cannot erase negations, outage qualifications, unknown schedules or additional operating restrictions', () => {
  for (const tail of ['U/S EXC TOP LIGHT', 'U/S WHEN CRANE EXTENDED', 'NOT U/S', 'FLAGGED, NOT LGTD',
    'NOT FLAGGED AND LGTD', 'U/S DLY SR-SS', 'U/S. ACFT AVOID WI 500FT.', 'LGTD ONLY WHEN ERECTED']) {
    const record=notice({text:`${point} ${tail}`}), mapped=chartedNotamPresentation(record)!;
    assert.ok(mapped.presentation.searchText.toUpperCase().replace(/\s+/g,' ').includes(tail),tail);
    assert.ok(!parseNotam(record).facts.some(f=>f.label==='Obstacle Light Outage'),tail);
    assert.deepEqual(auditMappedNotam(record),[],tail);
    assert.ok(auditMappedNotam(record,{blocks:[],sourceSpans:[],searchText:''}).length,`audit must detect erased ${tail}`);
  }
  assert.equal(notamObstacles(notice({text:point.replace('(.2NM S TST)','(ONLY WHEN ERECTED)')})).length,0);
  assert.equal(parseNotam(notice({text:`XYZ ${point} U/S`})).subject,undefined,'unassociated prefix cannot acquire a subject');
});

test('semantic binding audit rejects equal-number multisets with swapped labels, categories, runways or climb stages', () => {
  const source='LNAV CAT A MDA 500/HAT 400, CAT B MDA 600/HAT 500.';
  const block=presentNotam(notice({text:source})).blocks[0]!;
  assert.equal(block.kind,'minima'); if (block.kind!=='minima') return;
  const swapped=structuredClone(block); [swapped.rows[0]!.values[0]!.value,swapped.rows[0]!.values[1]!.value]=['400','500'];
  assert.ok(auditValueBindings(source,swapped).length);
  const categories=structuredClone(block); [categories.rows[0]!.categories,categories.rows[1]!.categories]=['CAT B','CAT A'];
  assert.ok(auditValueBindings(source,categories).length);
  const climb='TAKEOFF MINIMUMS RWY 8L, STANDARD WITH MINIMUM CLIMB OF 500FT/NM TO 520, THEN MINIMUM CLIMB OF 391FT/NM TO 1700.';
  const departure=presentNotam(notice({text:climb})).blocks[0]!;
  assert.equal(departure.kind,'takeoff'); if (departure.kind!=='takeoff') return;
  assert.ok(auditValueBindings(climb,{...departure,runway:'8R'}).length);
  assert.ok(auditValueBindings(climb,{...departure,options:[{minimums:'Standard minimums',climb:{gradient:'391',altitude:'1700'},then:[{gradient:'500',altitude:'520'}]}]}).length);
});

test('new takeoff grammar never transfers aircraft scopes, stage units or unknown qualifications', () => {
  for (const source of [
    'TAKEOFF MINIMUMS: JETS: RWYS 31L/R: STANDARD, PROPS: STANDARD.',
    'TAKEOFF MINIMUMS: JETS: RWYS 31L/R: STANDARD, HELICOPTERS: RWY 31L: STANDARD.',
    'TAKEOFF MINIMUMS RWY 8L, STANDARD WITH MINIMUM CLIMB OF 500FT/NM TO 520, THEN MINIMUM CLIMB OF 391 TO 1700.',
    'TAKEOFF MINIMUMS RWY 8L, STANDARD WITH MINIMUM CLIMB OF 500FT/NM TO 520, THEN MINIMUM CLIMB OF 391FT/MIN TO 1700.',
    'TAKEOFF MINIMUMS RWY 8L, 300-1 OR DEPARTURE NA EXC JETS.',
  ]) assert.equal(takeoffMinimumsGroup(source),undefined,source);
});

test('unrecognized conditional boundaries keep later minima as prose and never produce operative claims', () => {
  for (const condition of ['EXC CAT A:', 'PROVIDED AUTHORIZED:', 'IF APPROVED:', 'ONLY WHEN AUTHORIZED:']) {
    const record=notice({text:`IAP TEST, CA. ILS RWY 09L, AMDT 1... ${condition} USE EXISTING PROCEDURE. DA 500/HAT 200. VIS RVR 4000.`});
    assert.ok(presentNotam(record).blocks.every(b=>!['minima','minima-group'].includes(b.kind)),condition);
    assert.ok(!parseNotam(record).facts.some(f=>['Minima Amended','Visibility Amended'].includes(f.label)),condition);
  }
});

test('temporal qualification rejects duplicate, stale, mixed or degraded feeds instead of counting new downloads', () => {
  const first:CaptureEvidence={capturedAt:1_000_000,airports:['TST/KTST'],generations:['a'],checks:[990_000],healthy:true,recordVersions:['id:one'],errors:[]};
  const next={...first,capturedAt:1_200_000,checks:[1_190_000],generations:['b'],recordVersions:['id:two']};
  assert.equal(assessNotamGenerations([first,next]).qualified,true);
  for(const changed of [{...next,generations:['a']},{...next,healthy:false},{...next,checks:[100_000]},
    {...next,checks:[2_000_000]},{...next,generations:['b','c']},{...next,errors:['wrong category']},
    {...next,airports:['ELSE/KELS']}]) assert.equal(assessNotamGenerations([first,changed]).qualified,false);
  const repeated=assessNotamGenerations([first,{...first,capturedAt:1_200_000}]);
  assert.equal(repeated.distinctRecordVersions,1); assert.equal(repeated.captures[1]!.newRecordVersions,0);
});
