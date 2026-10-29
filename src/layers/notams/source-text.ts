import type { NotamRecord } from '@zlayer/contracts';
import { noticeRepresentation, parseFdcIcaoFields, parseLocalNotice, type LocalNotice } from './representation';

const numberContent = (value: string) => /^\d+$/.test(value) ? value.replace(/^0+(?=\d)/, '') : value;
const normalized = (text: string) => noticeRepresentation(text)?.text;

export function noticeIntervalMatches(record: NotamRecord, notice: Pick<LocalNotice, 'start' | 'end'>, allowMissingEstimate = false): boolean {
  const compact = (time: number | null) => time !== null && time % 60_000 === 0
    ? new Date(time).toISOString().replace(/\D/g, '').slice(2, 12) : undefined;
  const permanent = notice.end === 'PERM', estimated = notice.end.endsWith('EST');
  return compact(record.startsAt) === notice.start &&
    (permanent ? record.endsAt === null && record.effectiveEnd === 'PERM' : compact(record.endsAt) === notice.end.replace(/EST$/, '')) &&
    (record.endKind === (permanent ? 'permanent' : estimated ? 'estimated' : 'fixed') ||
      allowMissingEstimate && !permanent && !estimated && record.endKind === 'estimated');
}

export function fdcBodyForms(record: NotamRecord, translation: string): Set<string> | undefined {
  // Prove each optional body wrapper against the complete shared LOCAL_FORMAT,
  // including its source identity and actual interval. A substring match or an
  // unrelated ICAO rendering (which may carry old dates) is not sufficient.
  const parsed = parseLocalNotice(translation);
  if (!parsed.ok) return;
  const notice = parsed.value, [year, number] = notice.number.split('/');
  if (notice.office !== 'FDC' || record.classification !== 'FDC' || record.series || !/^\d{4}$/.test(record.year) ||
    !record.year.endsWith(year!) || numberContent(record.number) !== numberContent(number!) ||
    !record.locations.includes(notice.location) || !noticeIntervalMatches(record, notice)) return;
  const { subject, body, preamble, subjectSeparator } = notice;
  // Only the keyword is optional. State text, punctuation and qualifiers remain
  // content in every form, including when the structured body omits the keyword.
  const bodies = [preamble + body, `${preamble}${subject}${subjectSeparator}${body}`];
  const intervals = ['', ' '].flatMap(left => ['', ' '].map(right => `${notice.start}${left}-${right}${notice.end}`));
  return new Set(bodies.flatMap(text => [text, ...intervals.map(interval => `${text} ${interval}`)]));
}
/** Recover a missing subject only through the same complete-body equivalence
 * used by collection. Multiple local representations must agree. Return source
 * text unchanged so every parser evidence span still addresses a raw string. */
export function qualifiedFdcLocalText(record: NotamRecord): string | undefined {
  const local = record.translations.filter(t => t.type === 'LOCAL_FORMAT');
  if (!local.length) return;
  if (new Set(local.map(t => normalized(t.text))).size !== 1) return fdcContinuationEvidence([record])?.localText;
  const body = normalized(record.text);
  return body !== undefined && fdcBodyForms(record, local[0]!.text)?.has(body) ? local[0]!.text : undefined;
}

const continuationFooter = 'ALL OTHER DATA REMAINS AS PUBLISHED.'.split(' ');
const departureTitle = 'TAKEOFF MINIMUMS AND (OBSTACLE) DEPARTURE PROCEDURES'.split(' ');
const tokensAt = (tokens: readonly string[], at: number, expected: readonly string[]) =>
  expected.every((word, index) => tokens[at + index] === word);

/** Recognize the evidenced ODP airport heading, before its complete procedure
 * title. Its literal words come from this notice, never an airport lookup. */
type ContinuationEnvelope = { tokens: string[]; repeated: string[]; contentStart: number };
function continuationEnvelope(notice: LocalNotice): ContinuationEnvelope | undefined {
  if (notice.subject !== 'ODP') return;
  const tokens = notice.body.split(' ');
  const end = tokens.findIndex((word, i) => i < 64 && /^[A-Z]{2}\.$/.test(word));
  if (end < 2 || !tokens.slice(0, end).some(word => word.endsWith(',')) ||
    !tokensAt(tokens, end + 1, departureTitle) || !tokensAt(tokens, tokens.length - continuationFooter.length, continuationFooter)) return;
  // A complete reference has exactly one closing footer. It cannot itself be
  // another collapsed multipart rendering or contain ambiguous repeated prose.
  if (tokens.some((word, i) => word === 'ALL' && i < tokens.length - continuationFooter.length && tokensAt(tokens, i, continuationFooter))) return;
  return { tokens, repeated: [...continuationFooter, ...tokens.slice(0, end + 1)], contentStart: end + 1 + departureTitle.length };
}

/** Two forward cursors consume every word. At a mismatch the only accepted
 * transition is the exact closing-footer/airport-heading pair from the complete
 * witness. No sentence, instruction, numeric value or punctuation is discarded. */
function continuedBodyMatches(body: string, reference: ContinuationEnvelope): boolean {
  const tokens = body.split(' '), expected = reference.tokens;
  let actualAt = 0, expectedAt = 0, repetitions = 0, matchedSinceBoundary = false;
  while (actualAt < tokens.length) {
    if (tokens[actualAt] === expected[expectedAt]) {
      actualAt++; expectedAt++; matchedSinceBoundary = true;
    } else {
      if (!matchedSinceBoundary || expectedAt <= reference.contentStart || expectedAt >= expected.length - continuationFooter.length ||
        ++repetitions > 31 || !tokensAt(tokens, actualAt, reference.repeated)) return false;
      actualAt += reference.repeated.length; matchedSinceBoundary = false;
    }
  }
  return expectedAt === expected.length;
}

/** Prove a collapsed ODP continuation against a complete current native notice
 * and its agreeing Q)-through-E) conversion. Older notices are never consulted.
 * Retained raw translations constrain sparse replays and PWA source selection. */
export function fdcContinuationEvidence(records: readonly NotamRecord[]): { body: string; localText: string } | undefined {
  if (!records.length || records.length > 2 || records.some(record => record.id !== records[0]!.id ||
    record.classification !== 'FDC' || record.lifecycle !== 'active' || record.changeType !== 'N' ||
    record.locations.length !== 1 || record.schedule.trim())) return;
  const local: { source: string; notice: LocalNotice }[] = [];
  for (const record of records) for (const translation of record.translations) {
    if (translation.type !== 'LOCAL_FORMAT') continue;
    const parsed = parseLocalNotice(translation.text);
    if (!parsed.ok || !fdcBodyForms(record, translation.text)) return;
    local.push({ source: translation.text, notice: parsed.value });
  }
  const reference = local.find(value => continuationEnvelope(value.notice));
  if (!reference) return;
  const envelope = continuationEnvelope(reference.notice)!;
  const identity = (notice: LocalNotice) => JSON.stringify([notice.office, notice.number, notice.location, notice.subject, notice.start, notice.end]);
  if (local.some(value => identity(value.notice) !== identity(reference.notice) || !continuedBodyMatches(value.notice.body, envelope))) return;
  let conversions = 0;
  const bodies: string[] = [];
  for (const record of records) {
    const body = normalized(record.text);
    if (body === undefined || !local.some(value => fdcBodyForms(record, value.source)?.has(body))) return;
    if (fdcBodyForms(record, reference.source)?.has(body)) bodies.push(record.text);
    for (const translation of record.translations) {
      if (translation.type !== 'OTHER:ICAO') continue;
      const parsed = parseFdcIcaoFields(translation.text);
      if (!parsed.ok) return;
      const fields = parsed.value;
      if (fields.locations.length !== 1 || !(fields.locations[0] === reference.notice.location ||
        record.icaoLocations.length === 1 && fields.locations[0] === record.icaoLocations[0]) ||
        !noticeIntervalMatches(record, fields) || fields.schedule || fields.lower || fields.upper ||
        fields.body !== `${reference.notice.location} ${reference.notice.body}`) return;
      conversions++;
    }
  }
  if (!conversions || !bodies.length) return;
  // Pick an original complete body, not an assembled or rewritten string.
  bodies.sort((a, b) => a.length - b.length || a.localeCompare(b));
  return { body: bodies[0]!, localText: reference.source };
}
