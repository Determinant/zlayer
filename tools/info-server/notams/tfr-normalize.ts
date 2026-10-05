import { SaxesParser } from 'saxes';
import { greatCircleCoordinates } from '@zlayer/domain';
import { isTfrNotice, TFR_MAX_NOTICES, type TfrArea, type TfrNotice, type TfrWindow } from '@zlayer/contracts';

export type TfrIndexEntry = { id: string; modifiedAt: number; title: string; type: string; facility: string; state: string };
/** FAA XML date fields are UTC; codeTimeZone controls the website's local display.
 * The supplied USNS UTC validity footer independently checks that interpretation. */
function utc(value: string): number {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(value)) throw new Error('Invalid TFR time');
  const time = Date.parse(value + 'Z');
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value + '.000Z') throw new Error('Invalid TFR time');
  return time;
}
export function parseTfrIndex(value: unknown): TfrIndexEntry[] {
  if (!Array.isArray(value) || value.length > TFR_MAX_NOTICES) throw new Error('Invalid TFR index');
  const result = value.map(v => {
    if (!v || typeof v !== 'object' || !/^\d\/\d{4}$/.test(v.notam_id) || !/^\d{12}$/.test(v.mod_abs_time) ||
      !['description', 'type', 'facility', 'state'].every(k => typeof v[k] === 'string' && v[k].length <= 2048)) throw new Error('Invalid TFR index entry');
    const t = v.mod_abs_time;
    return { id: v.notam_id, modifiedAt: utc(`${t.slice(0,4)}-${t.slice(4,6)}-${t.slice(6,8)}T${t.slice(8,10)}:${t.slice(10,12)}:00`),
      title: v.description, type: v.type, facility: v.facility, state: v.state };
  });
  if (new Set(result.map(v => v.id)).size !== result.length) throw new Error('Duplicate TFR index entry');
  return result;
}
type Node = { name: string; text: string; children: Node[] };
const children = (n: Node, name: string) => n.children.filter(c => c.name === name);
const child = (n: Node, name: string) => {
  const values = children(n, name);
  if (values.length !== 1) throw new Error(`Missing or repeated TFR ${name}`);
  return values[0]!;
};
const field = (n: Node, name: string) => {
  const values = children(n, name);
  if (values.length > 1) throw new Error(`Repeated TFR ${name}`);
  return values[0]?.text.trim() ?? '';
};
function xml(text: string): Node {
  if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('TFR detail too large');
  const root: Node = { name: '', text: '', children: [] }, stack = [root]; let count = 0;
  const parser = new SaxesParser({ xmlns: true });
  parser.on('doctype', () => { throw new Error('TFR DTD forbidden'); });
  parser.on('opentag', tag => {
    if (tag.uri || stack.length > 32 || ++count > 50_000) throw new Error('Unsupported TFR XML');
    const node = { name: tag.local, text: '', children: [] };
    stack.at(-1)!.children.push(node); stack.push(node);
  });
  parser.on('text', text => { stack.at(-1)!.text += text; });
  parser.on('cdata', text => { stack.at(-1)!.text += text; });
  parser.on('closetag', () => { stack.pop(); });
  parser.write(text).close();
  return child(child(child(child(root, 'XNOTAM-Update'), 'Group'), 'Add'), 'Not');
}
function altitude(n: Node, side: 'Lower' | 'Upper'): string {
  const value = field(n, `valDistVer${side}`), unit = field(n, `uomDistVer${side}`), datum = field(n, `codeDistVer${side}`);
  if (!/^\d+(?:\.\d+)?$/.test(value) || !['FT', 'FL'].includes(unit) || !['ALT', 'HEI', 'STD'].includes(datum)) return 'Check altitude';
  const label = value === '0' && unit === 'FT' ? 'SFC' : unit === 'FL' ? `FL${value}`
    : `${value} ft ${datum === 'HEI' ? 'AGL' : datum === 'STD' ? 'pressure altitude' : 'MSL'}`;
  return `${field(n, `codeExclVer${side}`) === 'EXCLUDE' ? 'Excluding ' : ''}${label}`;
}
function geometry(group: Node): TfrArea['geometry'] {
  const merged = children(group, 'abdMergedArea');
  // A single FAA merged boundary already includes its published shape operations.
  // Multiple boundaries need explicit hole/union semantics before they can be drawn.
  if (merged.length !== 1) return null;
  const vertices = children(merged[0]!, 'Avx');
  if (vertices.length < 4 || vertices.length > 8192) return null;
  const coordinate = (value: string, latitude: boolean) => {
    const match = /^(\d+(?:\.\d+)?)([NSEW])$/.exec(value);
    if (!match || !(latitude ? 'NS' : 'EW').includes(match[2]!) || Number(match[1]) > (latitude ? 90 : 180)) throw new Error('Invalid TFR coordinate');
    return Number(match[1]) * ('SW'.includes(match[2]!) ? -1 : 1);
  };
  if (vertices.some(v => field(v, 'codeType') !== 'GRC' || field(v, 'codeDatum') !== 'WGE')) return null;
  const ring = vertices.map(v => [coordinate(field(v, 'geoLong'), false), coordinate(field(v, 'geoLat'), true)] as [number, number]);
  if (!ring[0]!.every((v, i) => v === ring.at(-1)![i]) || new Set(ring.slice(0,-1).map(p => p.join(','))).size !== ring.length - 1) return null;
  const detailed: [number, number][] = [];
  for (let i = 1; i < ring.length; i++) {
    for (const [lon, lat] of greatCircleCoordinates(ring[i-1]!, ring[i]!).slice(0,-1)) {
      // Keep one local longitude interval, including Aleutian/date-line areas.
      detailed.push([ring[0]![0] + ((lon - ring[0]![0] + 540) % 360 - 180), lat]);
      if (detailed.length >= 8192 || Math.abs(lat) > 85) return null;
    }
  }
  if (Math.max(...detailed.map(p => p[0])) - Math.min(...detailed.map(p => p[0])) >= 180) return null;
  detailed[0] = ring[0]!; detailed.push([...ring[0]!]);
  return { type: 'Polygon', coordinates: [detailed] };
}
function schedules(n: Node, start: number, end: number | null): TfrWindow[] | null {
  try {
    const scheduled = field(n, 'isScheduledTfrArea');
    if (!['TRUE', 'FALSE'].includes(scheduled)) return null;
    const groups = children(n, 'ScheduleGroup');
    if (!groups.length) return scheduled === 'FALSE' ? [{ startsAt: start, endsAt: end }] : null;
    const names = children(n, 'dayCode').map(v => v.text.trim());
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const days = names.length === 1 && names[0] === 'Daily' ? [0,1,2,3,4,5,6] : names.map(v => dayNames.indexOf(v));
    return groups.map(group => {
      const begins = field(group, 'dateEffective'), ends = field(group, 'dateExpire');
      const startsAt = Math.max(start, begins ? utc(begins) : start);
      const limit = Math.min(end ?? Infinity, ends ? utc(ends) : Infinity);
      if (limit <= startsAt) throw new Error('Empty TFR window');
      const window: TfrWindow = { startsAt, endsAt: Number.isFinite(limit) ? limit : null };
      if (scheduled === 'TRUE') {
        if (field(group, 'isTimeSeparate') !== 'TRUE' || !days.length || days.some(d => d < 0)) throw new Error('Unsupported TFR recurrence');
        window.daily = { startSeconds: (utc(field(group, 'startTime')) / 1000) % 86400,
          endSeconds: (utc(field(group, 'endTime')) / 1000) % 86400, days };
      } else if (field(group, 'isTimeSeparate') !== 'FALSE') throw new Error('Unexpected TFR recurrence');
      return window;
    });
  } catch { return null; }
}
export function parseTfrDetail(text: string, entry: TfrIndexEntry): TfrNotice {
  const n = xml(text), identity = child(n, 'NotUid');
  const year = field(identity, 'dateIndexYear'), number = field(identity, 'noSeqNo');
  if (field(identity, 'txtNameAcctFac') !== 'FDC' || !/^\d{4}$/.test(year) || !/^\d{1,4}$/.test(number) ||
    `${year.slice(-1)}/${number.padStart(4, '0')}` !== entry.id) throw new Error('TFR detail identity mismatch');
  const raw = field(n, 'txtDescrUSNS') || field(n, 'txtDescrTraditional');
  const footer = /(\d{10})-(\d{10}|PERM)(?:\s+END PART \d+ OF \d+)?\s*$/.exec(raw);
  const fromStamp = (s: string) => utc(`20${s.slice(0,2)}-${s.slice(2,4)}-${s.slice(4,6)}T${s.slice(6,8)}:${s.slice(8,10)}:00`);
  const start = field(n, 'dateEffective'), end = field(n, 'dateExpire');
  const immediate = /EFFECTIVE IMMEDIATELY UNTIL FURTHER NOTICE\./.test(raw);
  const startsAt = start ? utc(start) : footer ? fromStamp(footer[1]!) : immediate ? utc(field(identity, 'dateIssued')) : NaN;
  const endsAt = end ? utc(end) : footer && footer[2] !== 'PERM' ? fromStamp(footer[2]!) : null;
  const stamp = (t: number) => new Date(t).toISOString().replace(/\D/g, '').slice(2,12);
  if (!Number.isFinite(startsAt) || !immediate && !raw.includes(`${stamp(startsAt)}-${endsAt === null ? 'PERM' : stamp(endsAt)}`)) throw new Error('TFR UTC validity mismatch');
  const areas = children(child(n, 'TfrNot'), 'TFRAreaGroup').map(group => {
    const area = child(group, 'aseTFRArea');
    return { id: field(child(area, 'AseUid'), 'codeId'), name: field(area, 'txtName'),
      lower: altitude(area, 'Lower'), upper: altitude(area, 'Upper'), geometry: geometry(group), windows: schedules(area, startsAt, endsAt) };
  });
  const result = { ...entry, startsAt, endsAt, text: raw, areas };
  if (!isTfrNotice(result)) throw new Error('Invalid normalized TFR');
  return result;
}
