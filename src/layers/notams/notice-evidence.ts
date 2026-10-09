import type { NotamRecord } from '@zlayer/contracts';
import { fdcBodyForms, noticeIntervalMatches } from './source-text';
import { equalNotamSchedules, parseNotamSchedule } from './schedule';
import { noticeRepresentation, parseIcaoNotice, parseLocalNotice, type IcaoContent, type Representation } from './representation';

const bodyContent = (text: string) => noticeRepresentation(text)?.text;
const numberContent = (value: string) => /^\d+$/.test(value) ? value.replace(/^0+(?=\d)/, '') : value;

export function completeLocalNotice(record: NotamRecord, text: string): boolean {
  const body = bodyContent(record.text);
  if (body === undefined) return false;
  if (record.classification === 'FDC') return !!fdcBodyForms(record, text)?.has(body);
  if (record.classification !== 'DOMESTIC' || record.series) return false;
  const parsed = parseLocalNotice(text); if (!parsed.ok) return false;
  const notice = parsed.value, number = notice.number.split('/')[1]!;
  if (notice.office !== record.accountability || !record.locations.includes(notice.location) ||
    (numberContent(record.number) !== numberContent(number) && record.number !== notice.number) || !noticeIntervalMatches(record, notice)) return false;
  if (notice.body === body) return true;
  const schedule = parseNotamSchedule(record.schedule);
  return schedule.kind !== 'empty' && notice.body.startsWith(`${body} `) &&
    equalNotamSchedules(schedule, parseNotamSchedule(notice.body.slice(body.length + 1)));
}

export function localKey(record: NotamRecord): string | undefined {
  const local = record.translations.filter(t => t.type === 'LOCAL_FORMAT');
  if (!local.length) return;
  let key: string | undefined;
  for (const { text } of local) {
    const parsed = parseLocalNotice(text);
    if (!parsed.ok || !completeLocalNotice(record, text)) return;
    const { representation: _representation, segments: _segments, ...content } = parsed.value;
    const next = JSON.stringify(content);
    if (key !== undefined && key !== next) return;
    key = next;
  }
  return key;
}
export function sharedLocalNotice(previous: NotamRecord, next: NotamRecord): boolean {
  const before = localKey(previous);
  return before !== undefined && before === localKey(next);
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

function bindsIcaoRecord(record: NotamRecord, notice: IcaoContent): boolean {
  return /^[A-Z]$/.test(record.series) && /^\d{1,4}$/.test(record.number) && /^\d{4}$/.test(record.year) &&
    record.changeType === notice.change &&
    notice.identity === `${record.series}${record.number.padStart(4, '0')}/${record.year.slice(-2)}` &&
    notice.locations.some(code => [...record.locations, ...record.icaoLocations].includes(code)) &&
    noticeIntervalMatches(record, notice, true) &&
    equalNotamSchedules(parseNotamSchedule(notice.schedule), parseNotamSchedule(record.schedule));
}

/** All supplied ICAO renderings must parse and account for the whole primary
 * body. Never silently skip an unknown or contradictory retained translation.
 * Record binding is separately required for semantic corrections. Unchanged
 * envelopes can prove representation equality even when source metadata itself
 * is inconsistent; this never repairs or chooses between those metadata fields. */
export function icaoEvidence(record: NotamRecord): IcaoEvidence | undefined {
  if (icaoCache.has(record)) return icaoCache.get(record) ?? undefined;
  icaoCache.set(record, null);
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
    if (!parsed.ok || parsed.value.change !== 'N' || !matchesIcaoBody(primary.text, parsed.value, 32)) return;
    const { representation: _representation, segments: _segments, ...content } = parsed.value;
    recordBound &&= bindsIcaoRecord(record, content);
    translationAnnotation ||= rendering.annotated;
    notices.push(content);
  }
  const evidence = { notices, recordBound, bodyAnnotation: primary.annotated, translationAnnotation };
  icaoCache.set(record, evidence); return evidence;
}
