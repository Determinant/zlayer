import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NotamList } from '../src/layers/notams/ui';
import { notice, NOTAM_NOW } from './fixtures/notams';

type Entry = ComponentProps<typeof NotamList>['entries'][number];
const entry = (number: string, overrides: Parameters<typeof notice>[0] = {}): Entry => ({
  record: notice({ id: number.padStart(16, '0'), sourceId: number.padStart(16, '0'), number,
    text: `NOTICE ${number}`, translations: [], ...overrides }),
});
const render = (entries: Entry[], now = NOTAM_NOW) => renderToStaticMarkup(createElement(NotamList, { entries, now }));
const headings = (html: string) => [...html.matchAll(/<h3[^>]*>([^<]+)/g)].map(match => match[1]!.trim());
function assertBefore(html: string, first: string, second: string) {
  const start = html.indexOf(first), end = html.indexOf(second);
  assert.ok(start >= 0 && end > start, `${first} must appear before ${second}`);
}

test('NOTAM lists separate active, uncertain and future notices without an Upcoming flair', () => {
  const html = render([
    entry('3', { startsAt: NOTAM_NOW + 60_000 }),
    entry('2', { startsAt: null }),
    entry('1'),
    entry('4', { schedule: 'DLY 1400-1600' }),
  ]);
  assert.deepEqual(headings(html), ['Active', 'Check timing', 'Upcoming']);
  assertBefore(html, 'NOTICE 1', 'Check timing');
  for (const text of ['NOTICE 2', 'NOTICE 4', 'Check Validity', 'Outside Schedule']) {
    assertBefore(html, 'Check timing', text);
    assertBefore(html, text, 'Upcoming');
  }
  assertBefore(html, 'Upcoming', 'NOTICE 3');
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
  assertBefore(before, 'NOTICE 1', 'Upcoming');
  assertBefore(before, 'Check Schedule', 'Upcoming');
  const after = render(entries, NOTAM_NOW + 60_000);
  assert.deepEqual(headings(after), ['Check timing']);
  for (const number of ['1', '2', '3']) assert.match(after, new RegExp(`NOTICE ${number}`));
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
    assertBefore(html, 'NOTICE 2', 'NOTICE 4');
    assertBefore(html, 'NOTICE 4', 'NOTICE 1');
    assertBefore(html, 'NOTICE 1', 'NOTICE 3');
  }
  const airport = render(entries);
  for (const [first, second] of [['1', '2'], ['2', '3'], ['3', '4']]) {
    assertBefore(airport, `NOTICE ${first}`, `NOTICE ${second}`);
  }
});
