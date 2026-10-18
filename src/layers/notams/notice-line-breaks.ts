import type { NotamRecord } from '@zlayer/contracts';
import { bindsIcaoRecord } from './notice-evidence';
import { noticeRepresentation, parseIcaoNotice, parseLocalNotice, icaoContentKey } from './representation';
import { noticeIntervalMatches } from './source-text';
import { notamTime } from './validity';

/** A literal source line break before a complete compact time interval can
 * witness a lost separator in another rendering. No other word boundary moves. */
function intervalBoundaries(source: string): { body: string; boundaries: Set<number> } | undefined {
  const body = noticeRepresentation(source)?.text;
  if (!body) return;
  const boundaries = new Set<number>();
  for (const match of source.matchAll(/[A-Z]([ \t]*(?:\r\n|\r|\n)[ \t]*)(\d{10})-(\d{10})(?=[ .\r\n]|$)/g)) {
    const start = notamTime('20' + match[2]), end = notamTime('20' + match[3]);
    if (start === null || end === null || end <= start) return;
    const prefix = noticeRepresentation(source.slice(0, match.index + 1))?.text;
    if (!prefix || boundaries.size >= 32) return;
    boundaries.add(prefix.length);
  }
  return boundaries.size ? { body, boundaries } : undefined;
}

function matches(source: string, witness: { body: string; boundaries: Set<number> }): boolean {
  const text = noticeRepresentation(source)?.text;
  if (text === undefined) return false;
  let offset = 0;
  for (let i = 0; i < witness.body.length; i++) {
    if (witness.boundaries.has(i) && text[offset] !== ' ') continue;
    if (text[offset++] !== witness.body[i]) return false;
  }
  return offset === text.length;
}

export function lineBreakNoticeEvidence(records: readonly NotamRecord[]): { body: string } | undefined {
  const parsed = records.flatMap(record => record.translations.filter(t => t.type === 'OTHER:ICAO').map(t => ({
    record, notice: parseIcaoNotice(t.text),
  })));
  // Complete, record-bound NOTAMN evidence is required in every observation.
  if (records.some(record => record.lifecycle !== 'active' || record.changeType !== 'N' ||
    !record.translations.some(t => t.type === 'OTHER:ICAO')) || !parsed.length) return;
  const notices = [];
  for (const item of parsed) {
    if (!item.notice.ok) return;
    const notice = item.notice.value;
    if (notice.segments.length !== 1 || notice.lower || notice.upper || !bindsIcaoRecord(item.record, notice)) return;
    notices.push(notice);
  }
  const first = notices[0]!, envelope = icaoContentKey({ ...first, body: '' });
  if (notices.some(notice => icaoContentKey({ ...notice, body: '' }) !== envelope)) return;
  for (const notice of notices) {
    const segment = notice.segments[0]!, source = notice.representation.source.slice(segment.start, segment.end);
    const witness = intervalBoundaries(source);
    if (!witness || notices.some(value => !matches(value.body, witness))) continue;
    if (records.some(record => !matches(record.text, witness))) continue;
    let complete = true;
    for (const record of records) for (const translation of record.translations) {
      if (translation.type === 'OTHER:ICAO') continue;
      if (translation.type !== 'LOCAL_FORMAT') { complete = false; break; }
      const local = parseLocalNotice(translation.text);
      if (!local.ok || local.value.office !== record.accountability || !record.locations.includes(local.value.location) ||
        local.value.number !== `${record.series}${record.number.padStart(4, '0')}/${record.year.slice(-2)}` ||
        !noticeIntervalMatches(record, local.value) || !matches(local.value.body, witness)) { complete = false; break; }
    }
    if (complete) {
      // Select an actual primary body that retains the witnessed separator.
      const body = records.find(record => noticeRepresentation(record.text)?.text === witness.body)?.text;
      if (body !== undefined) return { body };
    }
  }
  return;
}
