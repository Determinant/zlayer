import type { NotamRecord } from '@zlayer/contracts';
import { fdcBodyForms, noticeIntervalMatches } from './source-text';
import { equalNotamSchedules, parseNotamSchedule, notamScheduleFits, type WeeklyNotamSchedule } from './schedule';
import { noticeRepresentation, parseIcaoNotice, parseLocalNotice, icaoContentKey, type IcaoContent, type LocalNotice, type Representation } from './representation';
import { compareIcaoQualification } from './notice-qualification';

const bodyContent = (text: string) => noticeRepresentation(text)?.text;
const numberContent = (value: string) => /^\d+$/.test(value) ? value.replace(/^0+(?=\d)/, '') : value;

/** Domestic month/number and international series-number/year are different
 * identities. Padding changes only the decimal number, never the month. */
export function domesticNoticeNumber(value: string): string | undefined {
  const parts = /^(\d{2})\/(\d+)$/.exec(value);
  return parts ? `${parts[1]}/${numberContent(parts[2]!)}` : undefined;
}
export function bindsDomesticLocalNotice(record: NotamRecord, notice: LocalNotice): boolean {
  const identity = domesticNoticeNumber(notice.number);
  return identity !== undefined && record.classification === 'DOMESTIC' && !record.series && notice.office === record.accountability &&
    record.locations.includes(notice.location) &&
    (numberContent(record.number) === identity.split('/')[1] || domesticNoticeNumber(record.number) === identity) && noticeIntervalMatches(record, notice);
}

function completeLocalNotice(record: NotamRecord, notice: LocalNotice, source: string): boolean {
  const body = bodyContent(record.text);
  if (body === undefined) return false;
  if (record.classification === 'FDC') return !!fdcBodyForms(record, source)?.has(body);
  if (!bindsDomesticLocalNotice(record, notice)) return false;
  if (notice.body === body) return true;
  const schedule = parseNotamSchedule(record.schedule);
  return schedule.kind !== 'empty' && notice.body.startsWith(`${body} `) &&
    equalNotamSchedules(schedule, parseNotamSchedule(notice.body.slice(body.length + 1)));
}

type LocalContent = Readonly<Omit<LocalNotice, 'representation' | 'segments'>>;
export type LocalEvidence = Readonly<{ key: string; notice: LocalContent }>;
// Immutable record identity owns this compact evidence. Never retain token
// graphs or change the record's original headers, translations or body.
const localCache = new WeakMap<NotamRecord, LocalEvidence | null>();
export function localEvidence(record: NotamRecord): LocalEvidence | undefined {
  if (localCache.has(record)) return localCache.get(record) ?? undefined;
  localCache.set(record, null);
  const local = record.translations.filter(t => t.type === 'LOCAL_FORMAT');
  if (!local.length) return;
  let evidence: LocalEvidence | undefined;
  for (const { text } of local) {
    const parsed = parseLocalNotice(text);
    if (!parsed.ok || !completeLocalNotice(record, parsed.value, text)) return;
    const { representation: _representation, segments: _segments, ...content } = parsed.value;
    const key = JSON.stringify({ ...content, number: record.classification === 'DOMESTIC'
      ? domesticNoticeNumber(content.number) : content.number });
    if (evidence && evidence.key !== key) return;
    evidence ??= { key, notice: content };
  }
  localCache.set(record, evidence!); return evidence;
}
export const localKey = (record: NotamRecord): string | undefined => localEvidence(record)?.key;
export function sharedLocalEvidence(previous: NotamRecord, next: NotamRecord): LocalEvidence | undefined {
  const before = localEvidence(previous);
  return before && before.key === localEvidence(next)?.key ? before : undefined;
}
export function sharedLocalNotice(previous: NotamRecord, next: NotamRecord): boolean {
  return sharedLocalEvidence(previous, next) !== undefined;
}
export const icaoBody = (notice: IcaoContent) => notice.body + (notice.lower ? ` F) ${notice.lower}` : '') + (notice.upper ? ` G) ${notice.upper}` : '');

/** Match only the field boundaries established by a complete parsed notice.
 * Inputs are already lexical views; never decode again or rewrite body prose.
 * Repetition admits complete copies only, including mixed marker spacing. */
export function matchesIcaoBody(body: string | undefined, notice: IcaoContent, maxCopies = 1): boolean {
  if (body === undefined) return false;
  let offset = 0;
  const take = (value: string) => {
    if (!body.startsWith(value, offset)) return false;
    offset += value.length; return true;
  };
  for (let copy = 0; copy < maxCopies; copy++) {
    if (!take(notice.body)) return false;
    for (const [marker, value] of [['F)', notice.lower], ['G)', notice.upper]] as const) {
      if (!value) continue;
      if (!take(` ${marker}`)) return false;
      take(' ');
      if (!take(value)) return false;
    }
    if (offset === body.length) return true;
    if (!take(' ')) return false;
  }
  return false;
}

/** Recognize a distribution annotation, not arbitrary trailing prose. This only
 * segments lexical evidence; the comparison policy must still prove the entire
 * enclosing notice. See source-comparison.md for authority and supported scope. */
const foreignDisclaimers = [
  'UNITED STATES NOTAM OFFICE DISCLAIMS FOREIGN NOTAM ACCURACY OR COMPLETENESS',
  'UNITED STATES NOF DISCLAIMS FOREIGN NOTAM ACCURACY OR COMPLETENESS',
].map(text => text.split(' '));
function distributionContent(view: Representation): { text: string; source: string; annotated: boolean } {
  for (const words of foreignDisclaimers) {
    const at = view.tokens.length - words.length;
    if (at <= 0 || !words.every((word, i) => view.tokens[at + i]!.value === word)) continue;
    // Original bytes, not decoded comparison text, feed the next parser. This
    // avoids double entity decoding and preserves compact marker source spans.
    return { text: view.tokens.slice(0, at).map(token => token.value).join(' '),
      source: view.source.slice(view.tokens[0]!.start, view.tokens[at - 1]!.end), annotated: true };
  }
  return { text: view.text, source: view.source, annotated: false };
}

export type IcaoEvidence = {
  notices: readonly IcaoContent[];
  /** Equality of two envelopes is weaker than authority to correct a field. */
  recordBound: boolean;
  bodyAnnotation: boolean;
  translationAnnotation: boolean;
};
// Retain compact comparison contents, never the national dataset's token graph.
const icaoCache = new WeakMap<NotamRecord, IcaoEvidence | null>();
const aixmIcaoCache = new WeakMap<NotamRecord, IcaoEvidence | null>();

export function bindsIcaoIdentityAndInterval(record: NotamRecord, notice: IcaoContent): boolean {
  const number = numberContent(record.number);
  return /^[A-Z]$/.test(record.series) && /^\d{1,4}$/.test(number) && /^\d{4}$/.test(record.year) &&
    record.changeType === notice.change &&
    notice.identity === `${record.series}${number.padStart(4, '0')}/${record.year.slice(-2)}` &&
    notice.locations.some(code => [...record.locations, ...record.icaoLocations].includes(code)) &&
    noticeIntervalMatches(record, notice, true);
}
export function bindsIcaoRecord(record: NotamRecord, notice: IcaoContent): boolean {
  return bindsIcaoIdentityAndInterval(record, notice) &&
    equalNotamSchedules(parseNotamSchedule(notice.schedule), parseNotamSchedule(record.schedule));
}

/** A complete D field may witness missing structured hours independently of
 * timing evaluation. Bind identity/interval/body first, then check every
 * supplied schedule and every retained rendering against that same witness. */
export function sharedIcaoSchedule(previous: NotamRecord, next: NotamRecord): WeeklyNotamSchedule | undefined {
  let witness: WeeklyNotamSchedule | undefined;
  const notices: IcaoContent[] = [];
  for (const record of [previous, next]) {
    if (record.lifecycle !== 'active' || record.changeType !== 'N') return;
    const evidence = icaoEvidence(record, 'aixm');
    if (!evidence?.notices.length) return;
    for (const notice of evidence.notices) {
      const schedule = parseNotamSchedule(notice.schedule);
      if (!bindsIcaoIdentityAndInterval(record, notice) || schedule.kind !== 'weekly' || !schedule.window ||
        !notamScheduleFits(parseNotamSchedule(record.schedule), schedule)) return;
      if (witness && !equalNotamSchedules(witness, schedule)) return;
      notices.push({ ...notice, schedule: '' }); witness = schedule;
    }
  }
  // Schedule agreement and record binding are established above. Other content
  // must be equal or independently qualified across the complete retained set;
  // a corrected Q field must not invalidate the same complete D-field witness.
  const key = notices[0] && icaoContentKey(notices[0]);
  return notices.every(notice => icaoContentKey(notice) === key) || compareIcaoQualification(notices) ? witness : undefined;
}

/** All supplied ICAO renderings must parse and account for the whole primary
 * body. Never silently skip an unknown or contradictory retained translation.
 * Record binding is separately required for semantic corrections. Unchanged
 * envelopes can prove representation equality even when source metadata itself
 * is inconsistent; this never repairs or chooses between those metadata fields. */
export function icaoEvidence(record: NotamRecord, textKind: 'rendered' | 'aixm' = 'rendered'): IcaoEvidence | undefined {
  // AIXM event:text owns E); F/G remain separate fields in every full translation.
  // Reconciliation accepts that E-only body or the existing complete E-through-G
  // rendering. Client subject recovery keeps its existing rendered-body contract.
  const cache = textKind === 'aixm' ? aixmIcaoCache : icaoCache;
  if (cache.has(record)) return cache.get(record) ?? undefined;
  cache.set(record, null);
  const translations = record.translations.filter(t => t.type === 'OTHER:ICAO');
  if (!translations.length) return;
  const view = noticeRepresentation(record.text);
  if (!view) return;
  const distribution = record.classification === 'INTL' && record.lifecycle === 'active' && record.changeType === 'N';
  const primary = distribution ? distributionContent(view) : { text: view.text, annotated: false };
  const notices: IcaoContent[] = [];
  let recordBound = true, translationAnnotation = false;
  for (const { text } of translations) {
    const view = noticeRepresentation(text, true);
    if (!view) return;
    const rendering = distribution ? distributionContent(view) : { source: text, annotated: false };
    const parsed = parseIcaoNotice(rendering.source);
    if (!parsed.ok || parsed.value.change !== 'N') return;
    if (!matchesIcaoBody(primary.text, parsed.value, 32) &&
      !(textKind === 'aixm' && primary.text === parsed.value.body)) return;
    const { representation: _representation, segments: _segments, ...content } = parsed.value;
    recordBound &&= bindsIcaoRecord(record, content);
    translationAnnotation ||= rendering.annotated;
    notices.push(content);
  }
  const evidence = { notices, recordBound, bodyAnnotation: primary.annotated, translationAnnotation };
  cache.set(record, evidence); return evidence;
}
