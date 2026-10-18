import type { NotamRecord } from '@zlayer/contracts';
import { sharedLocalNotice } from '../../../src/layers/notams/notice-evidence';
import { noticeRepresentation, parseIcaoNotice, parseLocalNotice } from '../../../src/layers/notams/representation';
import { noticeIntervalMatches } from '../../../src/layers/notams/source-text';
import { equalNotamSchedules, parseNotamSchedule } from '../../../src/layers/notams/schedule';

/** Two supplied scopes, not two aliases for an airport. Keep the source's
 * station-prefixed lookup and an explicitly witnessed FIR lookup together.
 * Airport/airport disagreements have no such proof and remain unresolved. */
export function complementaryNotamScopes(previous: NotamRecord, next: NotamRecord): string[] | undefined {
  if (previous.id !== next.id || previous.classification !== 'DOMESTIC' || next.classification !== 'DOMESTIC' ||
    previous.lifecycle !== 'active' || next.lifecycle !== 'active' || previous.changeType !== 'N' || next.changeType !== 'N' ||
    previous.series || next.series || previous.year !== next.year || !/^\d{4}$/.test(previous.year) ||
    previous.locations.length !== 1 || previous.locations[0] !== next.locations[0] || next.locations.length !== 1 ||
    !/^[A-Y][A-Z]{2}$/.test(previous.locations[0]!) || previous.icaoLocationVariants || next.icaoLocationVariants) return;
  if (!sharedLocalNotice(previous, next)) {
    const retained = previous.sourceIcaoLocations ? previous : next.sourceIcaoLocations ? next : undefined;
    const sparse = retained === previous ? next : previous;
    if (!retained || sparse.translations.some(t => t.type === 'LOCAL_FORMAT') ||
      !sharedLocalNotice(retained, { ...sparse, translations: [...sparse.translations,
        ...retained.translations.filter(t => t.type === 'LOCAL_FORMAT')] })) return;
  }
  const station = previous.locations[0]!, prefixed = `K${station}`;
  const sets = [previous, next].flatMap(record => record.sourceIcaoLocations ?? [record.icaoLocations]);
  if (sets.some(set => set.length !== 1)) return;
  const codes = [...new Set(sets.flat())].sort();
  if (codes.length !== 2 || !codes.includes(prefixed)) return;
  const fir = codes.find(code => code !== prefixed)!;
  if (!/^KZ[A-Z]{2}$/.test(fir)) return;
  let witnessed = false;
  for (const record of [previous, next]) for (const translation of record.translations) {
    if (translation.type === 'LOCAL_FORMAT') continue; // Complete shared native evidence checked above.
    if (translation.type !== 'OTHER:ICAO') return;
    const parsed = parseIcaoNotice(translation.text);
    const body = noticeRepresentation(record.text)?.text;
    if (!body) return;
    if (parsed.ok) {
      const notice = parsed.value;
      if (!/^[A-Z]\d{4}\/\d{2}$/.test(notice.identity) || !notice.identity.endsWith(`/${record.year.slice(-2)}`) ||
        notice.change !== 'N' || notice.reference || notice.q[0] !== fir || notice.locations.length !== 1 || notice.locations[0] !== fir ||
        !noticeIntervalMatches(record, notice, true) || !equalNotamSchedules(parseNotamSchedule(record.schedule), parseNotamSchedule(notice.schedule)) ||
        notice.lower || notice.upper || ![body, `${station} ${body}`].includes(notice.body)) return;
      witnessed = true;
      continue;
    }
    // Observed legacy domestic conversion: NOTAMR lacks its reference. It
    // cannot establish lifecycle or FIR membership; accept only its complete
    // native identity, station, interval and NAV body, with the same FIR in Q.
    const local = record.translations.find(t => t.type === 'LOCAL_FORMAT');
    const native = local && parseLocalNotice(local.text);
    const view = noticeRepresentation(translation.text, true)?.text;
    const legacy = view && /^(\d{2}\/\d{3}) NOTAMR Q\) ?([A-Z]{3})\/\/IV\/BO\/AE\/000\/999\/\d{4}[NS]\d{5}[EW]\d{3} A\) ([A-Z]{3}) B\) (\d{10}) C\) (\d{10}(?:EST)?|PERM) E\) (.+)$/.exec(view);
    if (!native || !native.ok || !legacy || legacy[1] !== native.value.number || `K${legacy[2]}` !== fir || legacy[3] !== station ||
      legacy[4] !== native.value.start || legacy[5] !== native.value.end || !body.startsWith('NAV ') ||
      legacy[6] !== body.slice(4) || record.schedule) return;
  }
  return witnessed ? codes : undefined;
}
