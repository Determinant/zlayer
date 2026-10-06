import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseNotam } from '../src/layers/notams/parser';
import { notamFlairs, notamInterpretationNotes } from '../src/layers/notams/flairs';
import { presentNotam } from '../src/layers/notams/presentation';
import { chartedNotamPresentation, notamChartKey } from '../src/layers/notams/chart';
import { NotamList } from '../src/layers/notams/ui';
import { auditNotam, auditMappedNotam, auditRenderedNotam } from '../tools/audit-notams';
import { notice, NOTAM_NOW } from './fixtures/notams';

const summary = (text: string) => notamFlairs(parseNotam(notice({ text })));
const labels = (text: string) => summary(text).map(f => f.label);

test('the at-a-glance body retains distinct amendments while procedure lists stay in the body', () => {
  const source = notice({ text: 'IAP TEST, CA. ILS OR LOC RWY 09, AMDT 1... RNAV (GPS) RWY 09, AMDT 2... ' +
    'LNAV MDA 600/HAT 400 ALL CATS, VIS CAT C 1 1/2. CIRCLING CAT A MDA 700/HAA 500. VDP 1.5NM TO RW09.' });
  const parsed = parseNotam(source), before = JSON.stringify(parsed), flairs = notamFlairs(parsed);
  assert.deepEqual(flairs.map(f => f.label), ['Multiple Approaches', 'Minima Amended', 'Visibility Amended', 'Circling Minima', 'VDP Amended']);
  assert.equal(flairs[0]!.evidence.length, 2);
  for (const flair of flairs) for (const span of flair.evidence) assert.equal(source.text.slice(span.start, span.end), span.text);
  for (const title of ['ILS OR LOC RWY 09', 'RNAV (GPS) RWY 09']) assert.ok(presentNotam(source).searchText.includes(title));
  assert.equal(JSON.stringify(parsed), before, 'selecting badges cannot change interpretation or applicability');
  assert.deepEqual(auditNotam(source), []);
  assert.deepEqual(auditRenderedNotam(source), []);
  assert.deepEqual(labels('SID TEST, CA. ALPHA ONE DEPARTURE... BRAVO TWO DEPARTURE... ' +
    'TAKEOFF MINIMUMS RWY 09, 400-2 OR STANDARD WITH MINIMUM CLIMB OF 280 FT/NM TO 3000. TEMPORARY CRANE.'),
  ['Multiple Departures', 'Takeoff Minima Amended', 'Climb Gradient', 'Crane']);
});

test('facility summaries combine only a proven complete scope and retain closure qualifications', () => {
  assert.deepEqual(labels('RWY 09/27 CLSD'), ['RWY 09/27 · Closed']);
  assert.equal(summary('RWY 09/27 CLSD')[0]!.tone, 'danger');
  const qualified = summary('RWY 09/27 CLSD. EXC EMERG ACFT');
  assert.equal(qualified[0]!.label, 'RWY 09/27 · Closure Restriction');
  assert.equal(qualified[0]!.tone, 'caution');
  assert.match(qualified[0]!.evidence[0]!.text, /EXC EMERG ACFT/);
  assert.deepEqual(labels('RWY 09 N 1000FT CLSD'), ['RWY 09 · Segment Closed']);
  assert.deepEqual(labels('TWY A CLSD'), ['TWY A · Closed']);
  for (const text of ['TWY A BTN TWY B AND TWY C CLSD', 'TWY A, TWY B CLSD']) {
    assert.deepEqual(labels(text), ['Taxiway Closure'], 'a first taxiway identifier cannot scope a segment or compound closure');
  }
  assert.deepEqual(labels('RWY 09 PAPI U/S'), ['RWY 09 · PAPI Unavailable']);
  assert.deepEqual(labels('RWY 09 WIP'), ['RWY 09']);
});

test('outage and monitoring summaries retain their exact facility and reference identity', () => {
  assert.deepEqual(labels('NAV ILS RWY 09 GP U/S'), ['RWY 09 · GP Unavailable']);
  assert.deepEqual(labels('NAV ILS RWY 09 NOT MNT'), ['RWY 09 · ILS Unmonitored']);
  assert.deepEqual(labels('AD SEE FDC 6/1234'), ['Aerodrome', 'See NOTAM FDC 6/1234']);
  const reference = summary('RWY 09 CLSD SEE ABC 10/123');
  assert.deepEqual(reference.map(f => f.label), ['RWY 09 · Closed', 'See NOTAM ABC 10/123']);
  assert.equal(reference[1]!.evidence[0]!.text, 'SEE ABC 10/123');
});

test('mapped obstacle status remains readable independently of summary badge selection', () => {
  for (const [prefix, status] of [['CRANE', 'FLAGGED AND LGTD'], ['TOWER LGT', 'U/S']]) {
    const source = notice({ text: `OBST ${prefix} 370015N1220015W 350FT (200FT AGL) ${status}` });
    const parsed = parseNotam(source), reading = chartedNotamPresentation(source)!.presentation;
    assert.ok(parsed.facts.some(f => f.kind === (status === 'U/S' ? 'outage' : 'obstacle-marking')));
    assert.ok(reading.searchText.includes(status === 'U/S' ? 'LGT U/S' : 'Flagged and LGTD'));
    assert.ok(!notamFlairs(parsed).some(f => f.label === 'Flagged and Lighted'));
    assert.deepEqual(auditMappedNotam(source), []);
    assert.deepEqual(auditRenderedNotam(source, true), []);
    assert.ok(auditMappedNotam(source, { blocks: [], sourceSpans: [], searchText: '' }).length, 'the audit must reject status lost from the body even when a badge exists');
    const html = renderToStaticMarkup(createElement(NotamList, { entries: [{ record: source }], now: NOTAM_NOW, charted: new Set([notamChartKey(source)]) }));
    assert.match(html, /class="notam-readable"/);
    assert.ok(html.includes(status === 'U/S' ? 'LGT U/S' : 'Flagged and LGTD'));
  }
});

test('uncertainty identifies its cause without changing matching coverage', () => {
  const cases: [string, string][] = [
    ['UNKNOWN WORDING', 'Subject Unclear'],
    ['NAV VOR U/S', 'Procedure Applicability Unconfirmed'],
    ['ODP TEST. GENERAL DEPARTURE MINIMUMS.', 'Affected Procedures Unclear'],
    ['IAP ALL IAPS NA EXCEPT RNAV.', 'Check Procedure Exceptions'],
    ['IAP TEST. SPECIAL ILS RWY 09, AMDT 1...', 'Procedure Wording Unclear'],
  ];
  for (const [text, label] of cases) {
    const parsed = parseNotam(notice({ text }));
    assert.equal(parsed.unresolved, true);
    assert.deepEqual(notamInterpretationNotes(parsed).map(n => n.label), [label]);
  }
  assert.deepEqual(notamInterpretationNotes(parseNotam(notice({ text: 'NAV ILS RWY 09 U/S' }))), []);
});
