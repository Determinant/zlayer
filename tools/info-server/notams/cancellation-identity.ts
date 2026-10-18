import type { NotamRecord } from '@zlayer/contracts';
import { noticeRepresentation, parseIcaoNotice } from '../../../src/layers/notams/representation';

const number = (value: string) => /^\d+$/.test(value) ? value.replace(/^0+(?=\d)/, '') : value;
const noticeId = /^([A-Z])(\d{4})\/(\d{2})$/;
const key = (value: { series: string; number: string; year: string }) =>
  `${value.series}${number(value.number).padStart(4, '0')}/${value.year.slice(-2)}`;

/** A NOTAMC envelope witnesses its own identity, never authority over the
 * referenced NMS record. Prefixes can expose contradictions; only complete
 * renderings can establish an omitted year. OPADD excludes item C). */
export function notamCancellationIdentity(record: NotamRecord) {
  let conflict = false, complete = false, understood = true, bodyBound = false, primaryHeader = false;
  const identities = new Set<string>(), references = new Set<string>();
  if (record.lifecycle !== 'cancellation' || record.changeType !== 'C') return { witness: false, conflict, identities, references, primaryHeader };
  if (record.referred) references.add(key(record.referred));
  const primary = noticeRepresentation(record.text, true)?.text;
  const locations = [...record.locations, ...record.icaoLocations];
  const start = record.startsAt !== null && record.startsAt % 60_000 === 0
    ? new Date(record.startsAt).toISOString().replace(/\D/g, '').slice(2, 12) : undefined;
  for (const text of [record.text, ...record.translations.map(t => t.text)]) {
    const tokens = noticeRepresentation(text, true)?.tokens ?? [];
    const own = noticeId.exec(tokens[0]?.value ?? '');
    if (!own || !/^NOTAM[NRC]$/.test(tokens[1]?.value ?? '')) {
      if (text !== record.text) understood = false;
      continue;
    }
    const reference = tokens[2]?.value ?? '';
    identities.add(own[0]);
    primaryHeader ||= text === record.text;
    if (tokens[1]!.value !== 'NOTAMC' || own[1] !== record.series || number(own[2]!) !== number(record.number) ||
      record.year && own[3] !== record.year.slice(-2) || !noticeId.test(reference)) conflict = true;
    references.add(reference);
    const brief = tokens.length === 3 || tokens.length === 5 && tokens[3]!.value === 'A)' && locations.includes(tokens[4]!.value);
    const parsed = parseIcaoNotice(text, { allowMissingEnd: true });
    const full = parsed.ok && parsed.value.change === 'C' && !parsed.value.end && !parsed.value.schedule &&
      !parsed.value.lower && !parsed.value.upper && parsed.value.locations.some(code => locations.includes(code)) &&
      parsed.value.start === start;
    understood &&= brief || full;
    complete ||= full;
    bodyBound ||= text === record.text && (brief || full) || full && parsed.ok && parsed.value.body === primary;
  }
  conflict ||= identities.size > 1 || references.size > 1;
  return { witness: !conflict && understood && complete && bodyBound, conflict, identities, references, primaryHeader };
}

/** Report the evidence fields even when identical raw headers contradict their
 * structured identity. Diagnostics and lifecycle decisions use the same rule. */
export function notamCancellationConflicts(previous: NotamRecord, next: NotamRecord): ('text' | 'translations' | 'referred')[] {
  if (previous.lifecycle !== 'cancellation' || next.lifecycle !== 'cancellation') return [];
  const before = notamCancellationIdentity(previous), after = notamCancellationIdentity(next);
  const a = previous.referred, b = next.referred;
  const conflict = before.conflict || after.conflict || new Set([...before.identities, ...after.identities]).size > 1 ||
    new Set([...before.references, ...after.references]).size > 1 ||
    !!(a && b && (a.series !== b.series || number(a.number) !== number(b.number) || a.year !== b.year));
  if (!conflict) return [];
  return (['text', 'translations', 'referred'] as const).filter(field => field === 'text' ? before.primaryHeader || after.primaryHeader
    : field === 'translations' ? previous.translations.length > 0 || next.translations.length > 0 : a !== null || b !== null);
}
