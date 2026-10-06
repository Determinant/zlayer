import assert from 'node:assert/strict';
import test from 'node:test';
import { maskNotamParts, notamParts } from '../src/layers/notams/multipart';
import { notamClauses, notamScopes } from '../src/layers/notams/clauses';
import { notamArea } from '../src/layers/notams/areas';
import { notice } from './fixtures/notams';

test('complete wrapped and NMS ending-only parts preserve source positions, including two-digit counts', () => {
  for (const opening of [false, true]) {
    const source = Array.from({ length: 10 }, (_, i) => `${opening ? `PART ${i + 1} OF 10 ` : ''}body ${i + 1} END PART ${i + 1} OF 10`).join('\n');
    const parts = notamParts(source)!;
    assert.equal(parts.length, 10);
    const masked = maskNotamParts(source, parts);
    assert.equal(masked.length, source.length);
    assert.doesNotMatch(masked, /PART/);
    for (let i = 1; i <= 10; i++) assert.equal(masked.indexOf(`body ${i}`), source.indexOf(`body ${i}`));
  }
  for (const source of ['body END PART 1 OF 10', 'PART 1 OF 2 body END PART 1 OF 2 PART 2 OF 2 body',
    'body END PART 2 OF 2 body END PART 1 OF 2', 'body END PART 1 OF 1 trailing',
    'PART 1 OF 1 END PART 1 OF 1', 'body PART 1 OF 1 body END PART 1 OF 1',
    'body END PART 1 OF 2 body END PART 1 OF 2', 'body END PART ONE OF TWO',
    'body END PART 1 OF 99999999999999999999999']) assert.equal(notamParts(source), undefined, source);
});

test('a boundary may continue through complete transport without losing vertex offsets or scope', () => {
  const source = 'PART 1 OF 2 AIRSPACE UAS WI AN AREA DEFINED AS 370000N1220000W TO 370000N1221000W END PART 1 OF 2\n' +
    'PART 2 OF 2 TO 371000N1221000W TO POINT OF ORIGIN SFC-400FT AGL END PART 2 OF 2';
  const area = notamArea(notice({ text: source }))!;
  assert.equal(area.polygons[0]![0]!.length, 4);
  assert.equal(area.preserveText, true);
  assert.equal(source.slice(area.span.start, area.span.end).startsWith('WI AN AREA'), true);
  assert.equal(source.slice(area.span.end).trimStart().startsWith('SFC-400FT'), true);
  assert.equal(notamArea(notice({ text: source.replace('PART 2 OF 2 TO', 'PART 2 OF 2 DELETE NOTE: TO') })), undefined);
});

test('sentence and exact-token consumers share sticky instruction and multipart transitions', () => {
  const source = 'ROUTE ZNY. IF AUTHORIZED, DELETE NOTE: HTO VOR R-236 UNUSABLE. HTO VOR R-240 UNUSABLE.';
  assert.equal(notamClauses(source, 128)!.at(-1)!.state, 'instruction');
  assert.equal(notamScopes(source)!.at(-1)!.state, 'instruction');
  assert.equal(notamScopes('DELETE NOTE: PART 1 OF 2. BODY.')!.at(-1)!.state, 'multipart');
});
