import type { NotamRecord } from '@zlayer/contracts';
import { sharedLocalEvidence, domesticNoticeNumber, type LocalEvidence } from '../../../src/layers/notams/notice-evidence';
import { noticeRepresentation, parseIcaoNotice, type IcaoNotice } from '../../../src/layers/notams/representation';
import { noticeIntervalMatches } from '../../../src/layers/notams/source-text';
import { equalNotamSchedules, parseNotamSchedule } from '../../../src/layers/notams/schedule';

// FAA 7930.2 §1-2-1: a domestic keyword categorizes the complete native body.
// A conversion may omit that leading keyword, never arbitrary words or suffixes.
const keywords = new Set(['RWY', 'TWY', 'APRON', 'AD', 'OBST', 'NAV', 'COM', 'SVC', 'AIRSPACE',
  'ODP', 'SID', 'STAR', 'CHART', 'DATA', 'DVA', 'IAP', 'VFP', 'ROUTE', 'SPECIAL', 'SECURITY']);
function convertedBodyMatches(body: string, converted: string, station: string): boolean {
  const forms = [body], boundary = body.indexOf(' ');
  if (boundary > 0 && keywords.has(body.slice(0, boundary))) forms.push(body.slice(boundary + 1));
  return forms.some(form => converted === form || converted === `${station} ${form}`);
}

function scopeNotice(previous: NotamRecord, next: NotamRecord): LocalEvidence | undefined {
  const shared = sharedLocalEvidence(previous, next);
  if (shared) return shared;
  const retained = previous.sourceIcaoLocations ? previous : next.sourceIcaoLocations ? next : undefined;
  const sparse = retained === previous ? next : previous;
  if (!retained || sparse.translations.some(t => t.type === 'LOCAL_FORMAT')) return;
  return sharedLocalEvidence(retained, { ...sparse, translations: [...sparse.translations,
    ...retained.translations.filter(t => t.type === 'LOCAL_FORMAT')] });
}

function conversionMatches(record: NotamRecord, notice: IcaoNotice, native: LocalEvidence['notice'], station: string, fir: string): boolean {
  const domestic = domesticNoticeNumber(notice.identity);
  const identity = domestic !== undefined ? domestic === domesticNoticeNumber(native.number)
    : /^[A-Z]\d{4}\/\d{2}$/.test(notice.identity) && /^\d{4}$/.test(record.year) && notice.identity.endsWith(`/${record.year.slice(-2)}`);
  const body = noticeRepresentation(record.text)?.text;
  // Q identifies the FIR; A can name the filing station, its supplied prefixed
  // lookup, or that FIR. A compatible native body grants no lifecycle authority.
  return identity && notice.change === 'N' && !notice.reference && notice.q[0] === fir && notice.locations.length === 1 &&
    [station, `K${station}`, fir].includes(notice.locations[0]!) && noticeIntervalMatches(record, notice, true) &&
    equalNotamSchedules(parseNotamSchedule(record.schedule), parseNotamSchedule(notice.schedule)) &&
    !notice.lower && !notice.upper && body !== undefined && convertedBodyMatches(body, notice.body, station);
}

/** Two supplied scopes, not two aliases for an airport. Keep the source's
 * station-prefixed lookup and an explicitly witnessed FIR lookup together.
 * Airport/airport disagreements have no such proof and remain unresolved. */
export function complementaryNotamScopes(previous: NotamRecord, next: NotamRecord): string[] | undefined {
  if (previous.id !== next.id || previous.classification !== 'DOMESTIC' || next.classification !== 'DOMESTIC' ||
    previous.lifecycle !== 'active' || next.lifecycle !== 'active' || previous.changeType !== 'N' || next.changeType !== 'N' ||
    previous.series || next.series || previous.year !== next.year || (previous.year && !/^\d{4}$/.test(previous.year)) ||
    previous.locations.length !== 1 || previous.locations[0] !== next.locations[0] || next.locations.length !== 1 ||
    !/^[A-Y][A-Z]{2}$/.test(previous.locations[0]!) || previous.icaoLocationVariants || next.icaoLocationVariants) return;
  const station = previous.locations[0]!, prefixed = `K${station}`;
  const sets = [previous, next].flatMap(record => record.sourceIcaoLocations ?? [record.icaoLocations]);
  if (sets.some(set => set.length !== 1)) return;
  const codes = [...new Set(sets.flat())].sort();
  if (codes.length !== 2 || !codes.includes(prefixed)) return;
  const fir = codes.find(code => code !== prefixed)!;
  if (!/^KZ[A-Z]{2}$/.test(fir)) return;
  const native = scopeNotice(previous, next);
  if (!native) return;
  let witnessed = false;
  for (const record of [previous, next]) for (const translation of record.translations) {
    if (translation.type === 'LOCAL_FORMAT') continue; // Complete shared native evidence checked above.
    if (translation.type !== 'OTHER:ICAO') return;
    const parsed = parseIcaoNotice(translation.text);
    if (parsed.ok) {
      if (!conversionMatches(record, parsed.value, native.notice, station, fir)) return;
      witnessed = true;
      continue;
    }
    // Observed legacy domestic conversion: NOTAMR lacks its reference. It
    // cannot establish lifecycle or FIR membership; accept only its complete
    // native identity, station, interval and NAV body, with the same FIR in Q.
    const body = noticeRepresentation(record.text)?.text;
    const view = noticeRepresentation(translation.text, true)?.text;
    const legacy = view && /^(\d{2}\/\d{3}) NOTAMR Q\) ?([A-Z]{3})\/\/IV\/BO\/AE\/000\/999\/\d{4}[NS]\d{5}[EW]\d{3} A\) ([A-Z]{3}) B\) (\d{10}) C\) (\d{10}(?:EST)?|PERM) E\) (.+)$/.exec(view);
    if (!legacy || domesticNoticeNumber(legacy[1]!) !== domesticNoticeNumber(native.notice.number) || `K${legacy[2]}` !== fir || legacy[3] !== station ||
      legacy[4] !== native.notice.start || legacy[5] !== native.notice.end || !body?.startsWith('NAV ') ||
      legacy[6] !== body.slice(4) || record.schedule) return;
  }
  return witnessed ? codes : undefined;
}
