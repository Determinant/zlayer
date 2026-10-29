import type { NotamRecord } from '@zlayer/contracts';
import { sharedLocalEvidence, domesticNoticeNumber, icaoEvidence, bindsIcaoIdentityAndInterval, type LocalEvidence } from '../../../src/layers/notams/notice-evidence';
import { noticeRepresentation, parseIcaoNotice, parseLocalNotice, icaoContentKey, type IcaoNotice } from '../../../src/layers/notams/representation';
import { noticeIntervalMatches } from '../../../src/layers/notams/source-text';
import { equalNotamSchedules, notamScheduleFits, parseNotamSchedule } from '../../../src/layers/notams/schedule';
import { isNotamSubject } from '../../../src/layers/notams/subjects';

type ScopeFailure = 'source-id-mismatch' | 'lifecycle-unproven' | 'filing-location-mismatch' |
  'projected-associations' | 'non-singleton-scope' | 'scope-count-limit' | 'scope-roles-unproven' |
  'domestic-profile-unproven' | 'native-evidence-unproven' | 'translation-type-unsupported' |
  'native-conversion-unproven' | 'missing-fir-witness' | 'missing-icao-witness' |
  'icao-rendering-or-body-unproven' | 'fir-mismatch' | 'icao-identity-or-interval-mismatch' |
  'schedule-mismatch' | 'icao-content-mismatch' | 'station-prefix-missing' |
  'local-syntax-unsupported' | 'local-identity-or-interval-mismatch' | 'local-body-mismatch' | 'local-content-mismatch';
type SuppliedScopes = { station: string; fir: string; codes: string[] };
export type NotamScopeComparison =
  | { outcome: 'proved'; witness: 'domestic' | 'icao'; scopes: string[] }
  | { outcome: 'unproven'; attempts: { witness: 'supplied-scopes' | 'domestic' | 'icao'; reason: ScopeFailure }[] };

// FAA 7930.2 §1-2-1: a domestic keyword categorizes the complete native body.
// A conversion may omit that leading keyword, never arbitrary words or suffixes.
function convertedBodyMatches(body: string, converted: string, station: string): boolean {
  const forms = [body], boundary = body.indexOf(' ');
  if (boundary > 0 && isNotamSubject(body.slice(0, boundary))) forms.push(body.slice(boundary + 1));
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

function suppliedScopes(previous: NotamRecord, next: NotamRecord): SuppliedScopes | ScopeFailure {
  if (previous.id !== next.id) return 'source-id-mismatch';
  if (previous.lifecycle !== 'active' || next.lifecycle !== 'active' ||
    previous.changeType !== 'N' || next.changeType !== 'N' || previous.referred || next.referred) return 'lifecycle-unproven';
  if (previous.locations.length !== 1 || next.locations.length !== 1 || previous.locations[0] !== next.locations[0]) return 'filing-location-mismatch';
  if (previous.icaoLocationVariants || next.icaoLocationVariants) return 'projected-associations';
  const station = previous.locations[0]!;
  const sets = [previous, next].flatMap(record => record.sourceIcaoLocations ?? [record.icaoLocations]);
  if (sets.some(set => set.length !== 1)) return 'non-singleton-scope';
  const codes = [...new Set(sets.flat())].sort();
  // Preserve only codes actually supplied by the source. A K-prefixed filing
  // lookup has the existing three-letter station profile; never invent it.
  const stationCodes = [station, ...(/^[A-Y][A-Z]{2}$/.test(station) ? [`K${station}`] : [])];
  const regions = codes.filter(code => !stationCodes.includes(code));
  // The published contract retains two original scope sets. Additional supplied
  // memberships remain a bounded issue; never discard one to fit that contract.
  if (codes.length > 2) return 'scope-count-limit';
  if (codes.length !== 2 || regions.length !== 1 || !/^[A-Z]{4}$/.test(regions[0]!)) return 'scope-roles-unproven';
  return { station, fir: regions[0]!, codes };
}

/** Native numbering binds domestic records even when the ICAO conversion has
 * a different series/number. Keep this authority separate from an ICAO identity. */
function domesticScopes(previous: NotamRecord, next: NotamRecord, scopes: SuppliedScopes): ScopeFailure | undefined {
  if (previous.classification !== 'DOMESTIC' || next.classification !== 'DOMESTIC' ||
    previous.series || next.series || previous.year !== next.year || (previous.year && !/^\d{4}$/.test(previous.year)) ||
    !/^[A-Y][A-Z]{2}$/.test(previous.locations[0] ?? '')) return 'domestic-profile-unproven';
  const { station, fir } = scopes;
  const native = scopeNotice(previous, next);
  if (!native) return 'native-evidence-unproven';
  let witnessed = false;
  for (const record of [previous, next]) for (const translation of record.translations) {
    if (translation.type === 'LOCAL_FORMAT') continue; // Complete shared native evidence checked above.
    if (translation.type !== 'OTHER:ICAO') return 'translation-type-unsupported';
    const parsed = parseIcaoNotice(translation.text);
    if (parsed.ok) {
      if (!conversionMatches(record, parsed.value, native.notice, station, fir)) return 'native-conversion-unproven';
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
      legacy[6] !== body.slice(4) || record.schedule) return 'native-conversion-unproven';
  }
  return witnessed ? undefined : 'missing-fir-witness';
}

/** A complete ICAO identity can instead bind the FIR directly. The primary
 * station and the FIR are distinct source query memberships, not aliases.
 * Q and A must independently identify the same supplied FIR, and every retained
 * rendering must agree. This proof does not depend on the classification label
 * or an assumed K-prefix/FIR spelling. */
function icaoScopes(previous: NotamRecord, next: NotamRecord, scopes: SuppliedScopes): ScopeFailure | undefined {
  const { station, fir } = scopes;
  const retained = [previous, next].find(record => record.sourceIcaoLocations &&
    record.translations.some(t => t.type === 'OTHER:ICAO'));
  let key: string | undefined, localKey: string | undefined;
  for (const record of [previous, next]) {
    // A sparse repeat may reuse an already established witness, but its own
    // identity, interval, schedule and entire body must still bind to it.
    const translations = !record.translations.some(t => t.type === 'OTHER:ICAO') && retained
      ? [...record.translations, ...retained.translations.filter(t => t.type === 'OTHER:ICAO')] : record.translations;
    if (!translations.some(t => t.type === 'OTHER:ICAO')) return 'missing-icao-witness';
    const evidence = icaoEvidence({ ...record, translations }, 'aixm');
    if (!evidence?.notices.length) return 'icao-rendering-or-body-unproven';
    for (const notice of evidence.notices) {
      const supplied = parseNotamSchedule(record.schedule), schedule = parseNotamSchedule(notice.schedule);
      if (notice.q[0] !== fir || notice.locations.length !== 1 || notice.locations[0] !== fir) return 'fir-mismatch';
      if (notice.reference || !bindsIcaoIdentityAndInterval({ ...record, icaoLocations: [fir] }, notice)) return 'icao-identity-or-interval-mismatch';
      if (!(equalNotamSchedules(supplied, schedule) || schedule.kind === 'weekly' && notamScheduleFits(supplied, schedule))) return 'schedule-mismatch';
      const content = icaoContentKey(notice);
      if (key !== undefined && key !== content) return 'icao-content-mismatch';
      key = content;
      // Bind the filing station to the complete operational body, not just to
      // contradictory metadata. Optional local renderings corroborate this role;
      // their separate domestic number never replaces the ICAO identity.
      if (!notice.body.startsWith(`${station} `)) return 'station-prefix-missing';
      for (const translation of record.translations) {
        if (translation.type === 'OTHER:ICAO') continue;
        if (translation.type !== 'LOCAL_FORMAT') return 'translation-type-unsupported';
        const parsed = parseLocalNotice(translation.text);
        if (!parsed.ok) return 'local-syntax-unsupported';
        const { representation: _representation, segments: _segments, ...local } = parsed.value;
        const number = domesticNoticeNumber(local.number);
        if (!number || local.location !== station || local.preamble || !noticeIntervalMatches(record, local)) return 'local-identity-or-interval-mismatch';
        if (!convertedBodyMatches(local.body, notice.body, station)) return 'local-body-mismatch';
        const content = JSON.stringify({ ...local, number });
        if (localKey !== undefined && localKey !== content) return 'local-content-mismatch';
        localKey = content;
      }
    }
  }
  return undefined;
}

/** The same evaluation supplies merge values and bounded diagnostic failures.
 * Each attempted witness reports its first failed check, not a repair instruction
 * or a claim that the notice's operational content is wrong. */
export function compareNotamScopes(previous: NotamRecord, next: NotamRecord): NotamScopeComparison {
  const scopes = suppliedScopes(previous, next);
  if (typeof scopes === 'string') return { outcome: 'unproven', attempts: [{ witness: 'supplied-scopes', reason: scopes }] };
  const domestic = domesticScopes(previous, next, scopes);
  if (!domestic) return { outcome: 'proved', witness: 'domestic', scopes: scopes.codes };
  const icao = icaoScopes(previous, next, scopes);
  return icao ? { outcome: 'unproven', attempts: [{ witness: 'domestic', reason: domestic }, { witness: 'icao', reason: icao }] }
    : { outcome: 'proved', witness: 'icao', scopes: scopes.codes };
}
