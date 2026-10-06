import type { NotamRecord, TfrNotice } from '@zlayer/contracts';
import { localNotamContent, parseNotam } from './parser';
import { notamParts } from './multipart';

const normalize = (text: string) => text.replace(/&(?:apos|quot|amp|lt|gt);|&#(?:39|34);/gi, entity =>
  ({ '&apos;': "'", '&#39;': "'", '&quot;': '"', '&#34;': '"', '&amp;': '&', '&lt;': '<', '&gt;': '>' })[entity.toLowerCase()]!)
  .toUpperCase().replace(/\s+/g, ' ').trim();

/** Compare complete, ordered parts while retaining every word of their bodies.
 * NMS omits the opening envelopes and per-part validity repeated by FAA TFR. */
function content(text: string, record: NotamRecord, notice: TfrNotice): string | undefined {
  if (text.length > 64 * 1024) return;
  const folded = normalize(text), parts = notamParts(folded);
  if (!parts) return;
  const compact = (time: number) => new Date(time).toISOString().replace(/\D/g, '').slice(2, 12);
  const interval = `${compact(notice.startsAt)}-${notice.endsAt === null ? 'PERM' : compact(notice.endsAt)}`;
  const bodies: string[] = [];
  for (const span of parts) {
    let part = folded.slice(span.start, span.end).trim();
    const header = /^!FDC (\d\/\d{4}) ([A-Z0-9]+)\s+/.exec(part);
    if (header && (header[1] !== notice.id || !record.locations.includes(header[2]!))) return;
    part = localNotamContent(part, record);
    if (span.opening) part = part.replace(/^PART \d+ OF \d+\s+/, '');
    const validity = /\s+(\d{10}-(?:\d{10}|PERM))(?:EST)?$/.exec(part);
    if (validity && validity[1] !== interval) return;
    bodies.push(validity ? part.slice(0, validity.index).trim() : part);
  }
  return bodies.join('\n');
}

/** Match the whole notice, not a SEE FDC pointer, reused number or named restricted area. */
export function chartedTfrReference(record: NotamRecord, shown: readonly TfrNotice[]): TfrNotice | undefined {
  if (record.classification !== 'FDC' || ['cancelled', 'cancellation'].includes(record.lifecycle)) return;
  const id = `${String(record.year).slice(-1)}/${record.number.padStart(4, '0')}`;
  const notice = shown.find(n => n.id === id && n.startsAt === record.startsAt);
  if (!notice) return;
  const body = content(record.text || parseNotam(record).body, record, notice);
  if (body === undefined || body !== content(notice.text, record, notice)) return;
  // NMS sometimes gives an exclusive end one minute after the identical FAA local text.
  // A differing metadata end needs that complete original-text agreement; no time tolerance.
  if (record.endsAt !== notice.endsAt && !record.translations.some(t => t.type === 'LOCAL_FORMAT' &&
      /\d{10}-(?:\d{10}(?:EST)?|PERM)$/.test(normalize(t.text)) && normalize(t.text) === normalize(notice.text))) return;
  return notice;
}
