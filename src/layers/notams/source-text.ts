import type { NotamRecord } from '@zlayer/contracts';

const numberContent = (value: string) => /^\d+$/.test(value) ? value.replace(/^0+(?=\d)/, '') : value;
const normalized = (text: string) => text.replace(/\s+/g, ' ').trim();

export function fdcBodyForms(record: NotamRecord, translation: string): Set<string> | undefined {
  // Prove each optional body wrapper against the complete shared LOCAL_FORMAT,
  // including its source identity and actual interval. A substring match or an
  // unrelated ICAO rendering (which may carry old dates) is not sufficient.
  const match = /^!FDC (\d)\/(\d{4}) ([A-Z0-9]{3,5}) (IAP|SID|STAR|ODP) (.+) (\d{10})-(\d{10})(EST)?$/.exec(translation);
  if (!match || record.classification !== 'FDC' || record.series || !/^\d{4}$/.test(record.year) ||
    !record.year.endsWith(match[1]!) || numberContent(record.number) !== numberContent(match[2]!) ||
    !record.locations.includes(match[3]!)) return;
  const compact = (time: number | null) => time !== null && time % 60_000 === 0
    ? new Date(time).toISOString().replace(/\D/g, '').slice(2, 12) : undefined;
  if (compact(record.startsAt) !== match[6] || compact(record.endsAt) !== match[7] ||
    record.endKind !== (match[8] ? 'estimated' : 'fixed')) return;
  const subject = match[4]!, body = match[5]!, interval = `${match[6]}-${match[7]}${match[8] ?? ''}`;
  return new Set([body, `${subject} ${body}`, `${body} ${interval}`, `${subject} ${body} ${interval}`]);
}
/** Recover a missing subject only through the same complete-body equivalence
 * used by collection. Multiple local representations must agree. Return source
 * text unchanged so every parser evidence span still addresses a raw string. */
export function qualifiedFdcLocalText(record: NotamRecord): string | undefined {
  const local = record.translations.filter(t => t.type === 'LOCAL_FORMAT');
  if (!local.length || new Set(local.map(t => normalized(t.text))).size !== 1) return;
  return fdcBodyForms(record, normalized(local[0]!.text))?.has(normalized(record.text)) ? local[0]!.text : undefined;
}
