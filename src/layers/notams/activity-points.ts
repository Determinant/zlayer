import type { NotamRecord } from '@zlayer/contracts';
import { localNotamContent, parseNotam } from './parser';
import { NOTAM_COORDINATE, notamCoordinate, type NotamCoordinate } from './coordinates';
import { notamScopes } from './clauses';
import { maskNotamParts, notamParts } from './multipart';

export type NotamActivityPoint = { coordinates: NotamCoordinate; label: string };
const cache = new WeakMap<NotamRecord, NotamActivityPoint | null>();
/** Source positions without a published footprint stay points; never invent a radius or balloon track. */
export function notamActivityPoint(record: NotamRecord): NotamActivityPoint | undefined {
  if (cache.has(record)) return cache.get(record) ?? undefined;
  const source = parseNotam(record).body, parts = notamParts(source);
  const text = parts ? localNotamContent(maskNotamParts(source, parts), record).toUpperCase() : '';
  const scopes = notamScopes(text);
  let result: NotamActivityPoint | undefined;
  if (scopes) {
    const laser = /^(?:[A-Z]{3} )?[A-Z]{2}\.\.AIRSPACE [A-Z ,.-]+\.\.LASER LGT DEMONSTRATION WI\s+AN AREA DEFINED AS\s+/.exec(text);
    const balloon = /^AIRSPACE UNMANNED FREE BALLOON\s+/.exec(text);
    const volcano = /^VOLCANIC ACTIVITY ADVISORY FOR [A-Z -]+ VOLCANO\s*\/\s*/.exec(text);
    const start = laser ?? balloon ?? volcano;
    if (start) {
      const matches = [...text.matchAll(NOTAM_COORDINATE)], coordinate = matches[0];
      const point = matches.length === 1 && coordinate?.index === start[0].length && notamCoordinate(coordinate);
      if (point && scopes.some(s => s.state === 'operative' && s.start === 0 && s.end >= coordinate!.index + coordinate![0].length)) result = { coordinates: point, label: laser ? 'Laser source\nSee NOTAM for affected distances'
        : balloon ? 'Balloon launch position\nSee NOTAM for movement' : 'Volcanic activity\nSource position' };
    }
  }
  cache.set(record, result ?? null); return result;
}
