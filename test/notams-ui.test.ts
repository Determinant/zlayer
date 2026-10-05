import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NotamList, NotamSourceIssues } from '../src/layers/notams/ui';
import { collectNotamRecords } from '../tools/info-server/notams/collection';
import { recordWithRevision } from '../tools/info-server/notams/normalize';
import { departureNotice, notice, NOTAM_NOW } from './fixtures/notams';

type Entry = ComponentProps<typeof NotamList>['entries'][number];
const entry = (number: string, overrides: Parameters<typeof notice>[0] = {}): Entry => ({
  record: notice({ id: number.padStart(16, '0'), sourceId: number.padStart(16, '0'), number,
    text: `NOTICE ${number}`, translations: [], ...overrides }),
});
const render = (entries: Entry[], now = NOTAM_NOW) => renderToStaticMarkup(createElement(NotamList, { entries, now }));
const headings = (html: string) => [...html.matchAll(/<h3[^>]*>([^<]+)/g)].map(match => match[1]!.trim());
test('source issues keep competing raw restrictions visible without presenting one as an operative notice', () => {
  const first = recordWithRevision(notice({ text: 'RWY 09L CLSD', translations: [] }));
  const second = recordWithRevision({ ...first, text: 'RWY 09L OPEN' });
  const { issues = [] } = collectNotamRecords({ records: [first] }, [second]);
  const html = renderToStaticMarkup(createElement(NotamSourceIssues, { issues }));
  assert.match(html, /Source data needs review/); assert.match(html, /No version has been chosen as authoritative/);
  assert.match(html, /RWY 09L CLSD/); assert.match(html, /RWY 09L OPEN/);
  assert.doesNotMatch(html, /notam-flair|Applies to this plate|notam-chart-note/);
  const global = renderToStaticMarkup(createElement(NotamSourceIssues, { issues: [{ ...issues[0]!, unscoped: true, variantsTruncated: true }] }));
  assert.match(global, /all airports/); assert.match(global, /not exhaustive/);
});
function assertBefore(html: string, first: string, second: string) {
  const start = html.indexOf(first), end = html.indexOf(second);
  assert.ok(start >= 0 && end > start, `${first} must appear before ${second}`);
}

test('airport and plate entries share readable runway options and keep exact raw source', () => {
  const record = departureNotice();
  for (const extra of [{}, { outcome: 'review' as const, reason: 'Check procedure applicability.' }]) {
    const html = render([{ record, ...extra }]);
    assertBefore(html, 'Runway 13', '412 ft/NM');
    assertBefore(html, '412 ft/NM', '3100-3');
    assertBefore(html, 'For climb in visual conditions', 'Runway 31');
    assertBefore(html, 'Runway 31', '210 ft/NM');
    assertBefore(html, 'All other data remains as published.', 'Show raw');
    assert.match(html.replace(/<[^>]*>/g, ''), /Until [^<]+\(estimated\)/);
    const raw = html.slice(html.indexOf('<details'));
    assert.ok(raw.includes(`<pre>${record.text}</pre>`));
    assert.ok(raw.includes(`<pre>${record.translations[0]!.text}</pre>`));
  }
});

test('NOTAM lists separate active, uncertain and future notices without an Upcoming flair', () => {
  const html = render([
    entry('3', { startsAt: NOTAM_NOW + 60_000 }),
    entry('2', { startsAt: null }),
    entry('1'),
    entry('4', { schedule: 'DLY 1400-1600' }),
  ]);
  assert.deepEqual(headings(html), ['Active', 'Check timing', 'Upcoming']);
  assertBefore(html, 'Notice 1', 'Check timing');
  for (const text of ['Notice 2', 'Notice 4', 'Check Validity', 'Outside Schedule']) {
    assertBefore(html, 'Check timing', text);
    assertBefore(html, text, 'Upcoming');
  }
  assertBefore(html, 'Upcoming', 'Notice 3');
  for (const [, flairs] of html.matchAll(/<div class="notam-flairs">([\s\S]*?)<\/div>/g)) {
    assert.doesNotMatch(flairs!, /Upcoming/);
  }
});

test('a notice moves from Upcoming to Active at its effective start, with no empty sections', () => {
  const entries = [entry('1', { startsAt: NOTAM_NOW + 60_000 })];
  assert.deepEqual(headings(render(entries, NOTAM_NOW + 59_999)), ['Upcoming']);
  assert.deepEqual(headings(render(entries, NOTAM_NOW + 60_000)), ['Active']);
  assert.equal(render([]), '');
});

test('uncertain ends and schedules never become Active merely because the start time has passed', () => {
  const entries = [
    entry('1', { endsAt: NOTAM_NOW - 1000, effectiveEnd: '202610041159', endKind: 'estimated' }),
    entry('2', { schedule: 'SR-SS' }),
    entry('3', { startsAt: NOTAM_NOW + 60_000, endsAt: null, effectiveEnd: '', endKind: 'unknown' }),
  ];
  const before = render(entries);
  assert.deepEqual(headings(before), ['Check timing', 'Upcoming']);
  assertBefore(before, 'Notice 1', 'Upcoming');
  assertBefore(before, 'Check Schedule', 'Upcoming');
  const after = render(entries, NOTAM_NOW + 60_000);
  assert.deepEqual(headings(after), ['Check timing']);
  for (const number of ['1', '2', '3']) assert.match(after, new RegExp(`Notice ${number}`));
});

test('plate timing sections put upcoming applies matches after current review candidates', () => {
  const html = render([
    { ...entry('2', { classification: 'FDC', startsAt: NOTAM_NOW + 60_000 }), outcome: 'applies', reason: 'Future procedure restriction.' },
    { ...entry('1'), outcome: 'review', reason: 'Review the displayed amendment.' },
  ]);
  assert.deepEqual(headings(html), ['Active', 'Upcoming']);
  assertBefore(html, 'Review applicability', 'Upcoming');
  assertBefore(html, 'Review the displayed amendment.', 'Upcoming');
  assertBefore(html, 'Upcoming', 'Applies to this plate');
  assertBefore(html, 'Upcoming', 'Future procedure restriction.');
});

test('plate groups put FDC notices first while preserving order within each class and in airport lists', () => {
  const entries = [
    entry('1', { issuedAt: NOTAM_NOW - 1000 }),
    entry('2', { classification: 'FDC', issuedAt: NOTAM_NOW - 2000 }),
    entry('3', { issuedAt: NOTAM_NOW - 3000, text: 'NOTICE 3 SEE FDC 6/0001' }),
    entry('4', { classification: 'FDC', issuedAt: NOTAM_NOW - 4000 }),
  ];
  for (const outcome of ['applies', 'review'] as const) {
    const html = render(entries.map(entry => ({ ...entry, outcome })));
    assertBefore(html, 'Notice 2', 'Notice 4');
    assertBefore(html, 'Notice 4', 'Notice 1');
    assertBefore(html, 'Notice 1', 'Notice 3');
  }
  const airport = render(entries);
  for (const [first, second] of [['1', '2'], ['2', '3'], ['3', '4']]) {
    assertBefore(airport, `Notice ${first}`, `Notice ${second}`);
  }
});
