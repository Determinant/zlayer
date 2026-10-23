import type { NotamRecord } from '@zlayer/contracts';
import { bindsDomesticLocalNotice, domesticNoticeNumber } from './notice-evidence';
import { noticeRepresentation, parseLocalNotice, parseIcaoNotice, icaoContentKey } from './representation';
import { noticeIntervalMatches } from './source-text';
import { equalNotamSchedules, parseNotamSchedule } from './schedule';

/** Read identifier slots only after an explicit surface keyword and before a
 * closure/segment boundary. A number followed by FT, dimensions, lists, punctuation
 * or unknown prose is not an identifier suffix. All other tokens remain exact. */
function surfaceBody(text: string) {
  const words = text.split(' '), content: string[] = [], split = new Set<number>(), compact = new Set<number>();
  if (!['APRON', 'TWY'].includes(words[0]!)) return;
  const boundary = (at: number) => words[at] === 'CLSD' || words[at] === 'BTN' ||
    /^(?:NORTH|SOUTH|EAST|WEST|NORTHEAST|NORTHWEST|SOUTHEAST|SOUTHWEST)$/.test(words[at] ?? '') && words[at + 1] === 'OF';
  for (let at = 0; at < words.length; at++) {
    const word = words[at]!; content.push(word);
    if (word !== 'TXL' && word !== 'TWY') continue;
    const slot = content.length;
    if (/^[A-Z]{1,2}$/.test(words[at + 1] ?? '') && /^[1-9]\d?$/.test(words[at + 2] ?? '') && boundary(at + 3)) {
      content.push(words[at + 1]! + words[at + 2]!); at += 2; split.add(slot);
    } else if (/^[A-Z]{1,2}[1-9]\d?$/.test(words[at + 1] ?? '') && boundary(at + 2)) {
      content.push(words[++at]!); compact.add(slot);
    }
    if (split.size + compact.size > 32) return;
  }
  return { key: content.join(' '), split, compact };
}

/** Equivalent designator spelling, not a general whitespace or typo repair.
 * Require complete bound domestic notices and account for every supplied native
 * and ICAO rendering. A compact spelling must actually occur at each joined slot.
 * Only comparison keys change; the result is an original primary source body. */
export function surfaceDesignatorEvidence(records: readonly NotamRecord[]): { body: string } | undefined {
  const bodies = records.map(record => {
    const view = noticeRepresentation(record.text);
    return view && surfaceBody(view.text);
  });
  const first = bodies[0];
  if (!first || records.some(record => record.id !== records[0]!.id || record.classification !== 'DOMESTIC' ||
    record.series || record.lifecycle !== 'active' || record.changeType !== 'N') || bodies.some(body => body?.key !== first.key)) return;
  const all = [...bodies];
  // Optional structured ICAO associations may be supplied by the other rendering
  // at this same identity; the record comparator independently constrains scopes.
  const locations = new Set(records.flatMap(record => [...record.locations, ...record.icaoLocations]));
  let localKey: string | undefined, icaoKey: string | undefined;
  for (const record of records) {
    let locals = 0;
    for (const translation of record.translations) {
      if (translation.type === 'LOCAL_FORMAT') {
        const parsed = parseLocalNotice(translation.text);
        if (!parsed.ok || !bindsDomesticLocalNotice(record, parsed.value)) return;
        const { representation: _representation, segments: _segments, ...notice } = parsed.value;
        const body = surfaceBody(notice.body);
        if (!body || body.key !== first.key) return;
        const key = JSON.stringify({ ...notice, number: domesticNoticeNumber(notice.number), body: body.key });
        if (localKey !== undefined && key !== localKey) return;
        localKey = key; locals++; all.push(body);
      } else if (translation.type === 'OTHER:ICAO') {
        const parsed = parseIcaoNotice(translation.text);
        if (!parsed.ok) return;
        const notice = parsed.value, body = surfaceBody(notice.body);
        if (!body || body.key !== first.key || notice.change !== 'N' || notice.segments.length !== 1 || notice.lower || notice.upper ||
          !noticeIntervalMatches(record, notice, true) ||
          !notice.locations.every(code => locations.has(code)) ||
          !equalNotamSchedules(parseNotamSchedule(record.schedule), parseNotamSchedule(notice.schedule))) return;
        const key = icaoContentKey({ ...notice, body: body.key });
        if (icaoKey !== undefined && key !== icaoKey) return;
        icaoKey = key; all.push(body);
      } else return;
    }
    if (!locals) return;
  }
  const split = new Set(all.flatMap(body => [...body!.split])), compact = new Set(all.flatMap(body => [...body!.compact]));
  if (!split.size || [...split].some(slot => !compact.has(slot))) return;
  // Presentation only: prefer an observed compact spelling, retaining every raw
  // translation. Length/delivery order never establishes content authority.
  const order = records.map((record, i) => ({ record, splits: bodies[i]!.split.size }))
    .sort((a, b) => a.splits - b.splits || a.record.text.localeCompare(b.record.text));
  return { body: order[0]!.record.text };
}
