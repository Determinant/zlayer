import type { NotamRecord } from '@zlayer/contracts';
import type { FeatureCollection, Point } from 'geojson';
import { localNotamContent, parseNotam } from './parser';
import { notamValidity } from './validity';
import { NOTAM_COORDINATE as coordinate, notamCoordinate } from './coordinates';

export type NotamObstacle = {
  coordinates: [number, number]; name: string; heightAglFt?: number; elevationMslFt: number;
  shape: 'low' | 'tall' | 'wind' | 'unknown'; grouped: boolean;
  /** The entire notice is an OBST report, rather than a procedure amendment. */
  standalone: boolean;
};
export type NotamObstacleProperties = { noticeId: string; icon: string; shape: NotamObstacle['shape']; label: string; elevationMslFt: number; timing: string };
export type NotamObstacleCollection = FeatureCollection<Point, NotamObstacleProperties>;
const cache = new WeakMap<NotamRecord, readonly NotamObstacle[]>();
const remainders = new WeakMap<NotamRecord, { text: string; lighting: boolean }>();

/** FAA 7930.2, 5-2-2 point OBST form: coordinates, MSL altitude, parenthesized AGL height.
 * Never substitute an airport/Q-line center, ASN/ASR reference, or a runway-relative estimate. */
export function notamObstacles(record: NotamRecord): readonly NotamObstacle[] {
  const saved = cache.get(record); if (saved) return saved;
  const body = localNotamContent(parseNotam(record).body, record);
  const parsed = parseObstacle(body), result: NotamObstacle[] = parsed ? [parsed.point] : [];
  if (parsed) remainders.set(record, parsed.remainder);
  // Some FDC procedures name individual permanent cranes with exact coordinates
  // and MSL only. Keep every point, and use a neutral position ring for unknown AGL.
  if (!parsed && body.length <= 64 * 1024 && /^(?:IAP|SID|STAR|ODP)\s/.test(body)) {
    for (const clause of body.split(/(?<=\.)\s+(?=[A-Z*#])/)) {
      if (/\b(?:ADD|CHANGE|DELETE|DISREGARD|NOTES?|UNLESS|EXCEPT|WHEN)\b|\bIF\s+/.test(clause)) break;
      const crane = /^(?:PERM|PERMANENT|TEMP|TEMPORARY) (CRANE|TOWER) \([A-Z0-9-]+\) (\d+(?:\.\d+)?)FT MSL(?: \([A-Z0-9]+\))? (.+)\.(?:\s+\d{10}-\d{10}(?:EST)?)?$/.exec(clause.trim());
      if (!crane) continue;
      const location = [...crane[3]!.matchAll(coordinate)];
      if (location.length !== 1 || location[0]![0] !== crane[3]) continue;
      const coordinates = notamCoordinate(location[0]!);
      if (!coordinates || Number(crane[2]) > 99_999) continue;
      result.push({ coordinates, name: crane[1] === 'CRANE' ? 'Crane' : 'Tower',
        elevationMslFt: Number(crane[2]), shape: 'unknown', grouped: false, standalone: false });
    }
  }
  cache.set(record, result);
  return result;
}
function parseObstacle(body: string): { point: NotamObstacle; remainder: { text: string; lighting: boolean } } | undefined {
  if (body.length > 64 * 1024 || !/^OBST\s/.test(body)) return undefined;
  const text = body.replace(/\s+/g, ' ').trim();
  // A farm/area/boundary's coordinate is not an individual obstacle position.
  if (/\b(?:AREA|RADIUS|FARM|FARMS|BTN|BETWEEN|WITHIN)\b/.test(text)) return undefined;
  const points = [...text.matchAll(coordinate)];
  if (points.length !== 1) return undefined;
  const point = points[0]!;
  const coordinates = notamCoordinate(point);
  if (!coordinates) return undefined;
  const prefix = text.slice(0, point.index);
  const kind = /^OBST (CRANES?|TOWERS?|STACKS?|BLDGS?|BUILDINGS?|WIND TURBINES?|WINDMILLS?|POLES?|RIGS?|TREES?)(?: LGT)?(?: \((?:ASN|ASR) [A-Z0-9 /.,-]+\))?\s*$/.exec(prefix);
  if (!kind) return undefined;
  const heights = /^(?:\s*\([.\d]+\s*NM\s+[NSEW]{1,3}\s+[A-Z0-9]+\))?\s+(-?\d+(?:\.\d+)?)\s*FT(?: MSL)?\s*\((\d+(?:\.\d+)?)\s*FT AGL\)(?=\s|\.|$)/.exec(text.slice(point.index + point[0].length));
  if (!heights) return undefined;
  const elevationMslFt = Number(heights[1]), heightAglFt = Number(heights[2]);
  if (Math.abs(elevationMslFt) > 99_999 || heightAglFt > 99_999) return undefined;
  const name = kind[1]!.replace(/^BLDGS?$/, value => value === 'BLDGS' ? 'Buildings' : 'Building').toLowerCase();
  return { point: { coordinates, name: name[0]!.toUpperCase() + name.slice(1), elevationMslFt, heightAglFt,
    shape: name.startsWith('wind') ? 'wind' : heightAglFt >= 1000 ? 'tall' : 'low', grouped: /S$/.test(kind[1]!), standalone: true },
    remainder: { text: text.slice(point.index + point[0].length + heights[0].length).trim(), lighting: /\bLGT\b/.test(prefix) } };
}

/** Only the validated location description is represented by the point symbol. */
export function mappedObstacleRemainder(record: NotamRecord): string | undefined {
  notamObstacles(record);
  const remainder = remainders.get(record);
  if (!remainder) return undefined;
  // Keep every qualification. Only an exact, unconditional status already visible
  // in a badge may be omitted; unknown schedules/wording stay in the reader.
  const flags = parseNotam(record).flairs.map(f => f.label);
  const status = remainder.text.replace(/\.$/, '');
  if (status === 'FLAGGED AND LGTD' && flags.includes('Flagged and Lighted') ||
    status === 'U/S' && remainder.lighting && flags.includes('Obstacle Light Outage')) return '';
  return `${remainder.lighting ? 'LGT ' : ''}${remainder.text}`.trim();
}

export function notamObstacleFeatures(records: readonly NotamRecord[], now: number): NotamObstacleCollection {
  const features: NotamObstacleCollection['features'] = [];
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.id) || ['cancelled', 'cancellation'].includes(record.lifecycle)) continue;
    seen.add(record.id);
    const obstacles = notamObstacles(record), timing = notamValidity(record, now);
    if (timing === 'past end') continue;
    const qualifier = timing === 'within interval' ? '' : `\n${timing.replace(/^./, char => char.toUpperCase())}`;
    for (const [index, obstacle] of obstacles.entries()) features.push({ type: 'Feature', id: `${record.id}:${index}`, geometry: { type: 'Point', coordinates: obstacle.coordinates }, properties: {
      noticeId: record.id, icon: `notam-obstacle-${obstacle.shape}-${obstacle.grouped ? 'group' : 'single'}`, shape: obstacle.shape,
      // Match DOF's MSL (AGL) feet convention; the warm color identifies the preview.
      label: `${obstacle.name}\n${obstacle.elevationMslFt} (${obstacle.heightAglFt ?? '?'})${qualifier}`,
      elevationMslFt: obstacle.elevationMslFt, timing,
    } });
  }
  return { type: 'FeatureCollection', features };
}
