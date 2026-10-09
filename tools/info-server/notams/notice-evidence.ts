import type { NotamRecord } from '@zlayer/contracts';
import { equalNotamSchedules, parseNotamSchedule } from '../../../src/layers/notams/schedule';

const normalized = (text: string) => text.trim().replace(/^<pre>([\s\S]*)<\/pre>$/i, '$1').replace(/\s+/g, ' ').trim();
type Notice = { identity: string; q: string; location: string; start: string; end: string; schedule: string; body: string };

/** Decode complete ICAO notices, rather than deleting multipart markers from
 * arbitrary text. Every part must carry the same identity and operative header,
 * and both its opening and closing part counts must describe one complete set. */
function single(text: string): Notice | undefined {
  const m = /^([A-Z]\d{4}\/\d{2}) NOTAMN Q\) (\S+) A\) ([A-Z0-9]{2,8}) B\) (\d{10}) C\) (\d{10}(?:EST)?|PERM) (?:D\) (.+?) )?E\) (.+)$/.exec(text);
  if (!m || /\b(?:END )?PART \d+ OF \d+\b/.test(text) || /(?:^| )[FG]\) /.test(m[7]!)) return;
  return { identity: m[1]!, q: m[2]!, location: m[3]!, start: m[4]!, end: m[5]!, schedule: m[6] ?? '', body: m[7]! };
}
function header(notice: Notice) { const { body: _body, ...value } = notice; return JSON.stringify(value); }
function decode(text: string): Notice | undefined {
  const ordinary = single(text);
  if (ordinary) return ordinary;
  const chunks = text.split(/ (?=[A-Z]\d{4}\/\d{2} NOTAMN Q\) )/);
  if (chunks.length < 2 || chunks.length > 32) return;
  const parts = new Map<number, Notice>();
  for (const chunk of chunks) {
    const m = /^(.* A\) [A-Z0-9]{2,8}) PART (\d+) OF (\d+) (B\) .+) END PART (\d+) OF (\d+)$/.exec(chunk);
    if (!m || m[2] !== m[5] || m[3] !== m[6] || Number(m[3]) !== chunks.length ||
      Number(m[2]) < 1 || Number(m[2]) > chunks.length || parts.has(Number(m[2]))) return;
    const notice = single(`${m[1]} ${m[4]}`);
    if (!notice) return;
    parts.set(Number(m[2]), notice);
  }
  const first = parts.get(1)!;
  if ([...parts.values()].some(part => header(part) !== header(first))) return;
  return { ...first, body: Array.from({ length: chunks.length }, (_, i) => parts.get(i + 1)!.body).join(' ') };
}
const cache = new WeakMap<NotamRecord, Notice | null>();
function evidence(record: NotamRecord): Notice | undefined {
  if (cache.has(record)) return cache.get(record) ?? undefined;
  cache.set(record, null);
  const translations = record.translations.filter(t => t.type === 'OTHER:ICAO');
  if (!translations.length || !/^[A-Z]$/.test(record.series) || !/^\d{1,4}$/.test(record.number) || !/^\d{4}$/.test(record.year)) return;
  const compact = (time: number | null) => time !== null && time % 60_000 === 0
    ? new Date(time).toISOString().replace(/\D/g, '').slice(2, 12) : undefined;
  const notices = translations.map(t => decode(normalized(t.text)));
  const notice = notices[0];
  if (!notice || notices.some(n => !n || JSON.stringify(n) !== JSON.stringify(notice)) ||
    notice.identity !== `${record.series}${record.number.padStart(4, '0')}/${record.year.slice(-2)}` ||
    ![...record.locations, ...record.icaoLocations].includes(notice.location) ||
    notice.start !== compact(record.startsAt) ||
    (notice.end === 'PERM' ? record.effectiveEnd !== 'PERM' || record.endsAt !== null
      : notice.end.replace(/EST$/, '') !== compact(record.endsAt)) ||
    !equalNotamSchedules(parseNotamSchedule(notice.schedule), parseNotamSchedule(record.schedule))) return;
  // A repeated source body is equivalent only when a complete, independently
  // identified notice witnesses each whole copy. Never deduplicate prose lines.
  const body = normalized(record.text), copies = (body.length + 1) / (notice.body.length + 1);
  if (!Number.isInteger(copies) || copies < 1 || copies > 32 || body !== Array(copies).fill(notice.body).join(' ')) return;
  cache.set(record, notice); return notice;
}

export function sharedIcaoNotice(a: NotamRecord, b: NotamRecord): boolean {
  const left = evidence(a), right = evidence(b);
  return !!left && !!right && JSON.stringify(left) === JSON.stringify(right);
}
