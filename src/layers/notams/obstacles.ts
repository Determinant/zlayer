import type { NotamRecord } from '@zlayer/contracts';
import type { FeatureCollection, Point } from 'geojson';
import { localNotamContent, parseNotam } from './parser';
import { notamValidity } from './validity';
import { NOTAM_COORDINATE as coordinate, notamCoordinate } from './coordinates';
import { coordinateToken, resolveCoordinate } from './coordinate-recovery';
import type { NotamAreaReferences } from './area-references';
import { notamClauses, notamScopes } from './clauses';
import { notamParts, maskNotamParts, type SourceSpan } from './multipart';
import { obstacleAnnotation, obstacleHeights, obstacleKind } from './obstacle-fields';

export type NotamObstacle = {
  coordinates: [number, number]; name: string; heightAglFt?: number; elevationMslFt?: number;
  shape: 'low' | 'tall' | 'wind' | 'unknown'; grouped: boolean;
  /** The entire notice is an obstruction report, rather than a procedure amendment. */
  standalone: boolean;
  recovered?: boolean;
  preserveText?: boolean;
  /** This occurrence only, in parseNotam(record).body; identical quoted points are unrelated. */
  coordinateSpan: SourceSpan;
};
export type NotamObstacleProperties = { noticeId: string; icon: string; shape: NotamObstacle['shape']; label: string; elevationMslFt?: number; timing: string };
export type NotamObstacleCollection = FeatureCollection<Point, NotamObstacleProperties>;
const cache = new WeakMap<NotamRecord, readonly NotamObstacle[]>();
const referenceCaches = new WeakMap<NotamAreaReferences, WeakMap<NotamRecord, readonly NotamObstacle[]>>();
const remainders = new WeakMap<NotamRecord, { text: string; lighting: boolean }>();

/** FAA 7930.2, 5-2-2 point OBST form: coordinates, MSL altitude, parenthesized AGL height.
 * Never substitute an airport/Q-line center, ASN/ASR reference, or a runway-relative estimate. */
export function notamObstacles(record: NotamRecord, references?: NotamAreaReferences): readonly NotamObstacle[] {
  let results = cache;
  if (references) {
    let current = referenceCaches.get(references);
    if (!current) { current = new WeakMap(); referenceCaches.set(references, current); }
    results = current;
  }
  const saved = results.get(record); if (saved) return saved;
  const source = parseNotam(record).body, parts = notamParts(source);
  if (!parts) { results.set(record, []); return []; }
  const masked = maskNotamParts(source, parts), body = localNotamContent(masked.trimStart(), record);
  const folded = body.toUpperCase();
  if (folded.length !== body.length) { results.set(record, []); return []; }
  const offset = masked.length - body.length, scopes = notamScopes(body);
  const operative = (start: number, end: number) => scopes?.some(s => s.state === 'operative' && start >= s.start && end <= s.end);
  const parsed = parseObstacle(body, offset, record, references), result: NotamObstacle[] =
    parsed && operative(0, parsed.point.coordinateSpan.end - offset) ? [parsed.point] : [];
  if (parsed?.remainder) remainders.set(record, parsed.remainder);
  // Some FDC procedures name individual permanent cranes with exact coordinates
  // and MSL only. Keep every point, and use a neutral position ring for unknown AGL.
  if (!parsed && /^(?:IAP|SID|STAR|ODP)\s/.test(folded)) {
    for (const clause of notamClauses(folded, 128) ?? []) {
      if (clause.state !== 'operative' || !operative(clause.start, clause.end)) continue;
      const finalApproach = /^\s*FAS OBST:\s*\d+\s+(CRANE|TOWER)\s+\([A-Z0-9-]+\)\s+(.+)\.(?:\s+\d{10}-\d{10}(?:EST)?)?\s*$/d.exec(clause.source);
      if (finalApproach) {
        const token = coordinateToken(finalApproach[2]!);
        if (token && token.length === finalApproach[2]!.length && Array.isArray(token.location)) {
          const start = offset + clause.start + finalApproach.indices![2]![0];
          result.push({ coordinates: token.location, coordinateSpan: { start, end: start + token.length }, name: finalApproach[1] === 'CRANE' ? 'Crane' : 'Tower',
            shape: 'unknown', grouped: false, standalone: false, preserveText: true, ...(token.recovered ? { recovered: true } : {}) });
        }
        continue;
      }
      const crane = /^\s*(?:PERM|PERMANENT|TEMP|TEMPORARY)\s+(CRANE|TOWER)\s+\([A-Z0-9-]+\)\s+(\d+(?:\.\d+)?)FT\s+MSL(?:\s+\([A-Z0-9]+\))?\s+(.+)\.(?:\s+\d{10}-\d{10}(?:EST)?)?\s*$/d.exec(clause.source);
      if (!crane) continue;
      const location = [...crane[3]!.matchAll(coordinate)];
      if (location.length !== 1 || location[0]![0] !== crane[3]) continue;
      const coordinates = notamCoordinate(location[0]!);
      if (!coordinates || Number(crane[2]) > 99_999) continue;
      const start = offset + clause.start + crane.indices![3]![0];
      result.push({ coordinates, coordinateSpan: { start, end: start + crane[3]!.length }, name: crane[1] === 'CRANE' ? 'Crane' : 'Tower',
        elevationMslFt: Number(crane[2]), shape: 'unknown', grouped: false, standalone: false });
    }
  }
  if (!result.length && operative(0, body.length)) {
    const content = folded;
    const ramp = /^ALL ALL ADC RAMP - OBSTRUCTION LIGHT OUTAGE ON RAMP LOCATED AT\s+(.+)$/d.exec(content);
    if (ramp) {
      const token = coordinateToken(ramp[1]!);
      if (token && token.length === ramp[1]!.length && Array.isArray(token.location)) {
        const start = offset + ramp.indices![1]![0];
        result.push({ coordinates: token.location, coordinateSpan: { start, end: start + token.length }, name: 'Obstruction light',
          shape: 'unknown', grouped: false, standalone: false, preserveText: true, ...(token.recovered ? { recovered: true } : {}) });
      }
    }
    // Route amendments can explicitly identify multiple controlling windmills; retain the entire amendment.
    const report = /^(?:ROUTE (?:Z[A-Z]{2} )?)?SPECIAL NY ROUTE [\s\S]+?REASON: NEW CONTROLLING OBSTACLES?: WINDMILLS?,\s*(.+)$/.exec(content);
    if (report) {
      const clauses = report[1]!.split(/\s+AND\s+/), points: NotamObstacle[] = [];
      let cursor = content.length - report[1]!.length;
      for (const clause of clauses) {
        const location = [...clause.matchAll(coordinate)];
        const match = location.length === 1 && location[0]!.index === 0 ? location[0] : undefined;
        const point = match && notamCoordinate(match);
        const heights = match && /^,\s*(\d+(?:\.\d+)?)FT AGL\/(\d+(?:\.\d+)?)FT MSL[.]?$/.exec(clause.slice(match[0].length));
        if (!point || !heights || Number(heights[1]) > 99999 || Number(heights[2]) > 99999) break;
        const start = content.indexOf(clause, cursor); cursor = start + clause.length;
        points.push({ coordinates: point, coordinateSpan: { start: offset + start, end: offset + start + match![0].length }, name: 'Windmill', heightAglFt: Number(heights[1]), elevationMslFt: Number(heights[2]),
          shape: 'wind', grouped: false, standalone: false });
      }
      if (points.length === clauses.length) result.push(...points);
    }
    const light = /^TOWER LGTS U\/S LOC (.+?) \d+(?:\.\d+)?FT HIGH[.]?$/.exec(content);
    if (light) {
      const match = [...light[1]!.matchAll(coordinate)];
      const point = match.length === 1 && match[0]![0] === light[1] && notamCoordinate(match[0]!);
      const start = offset + content.indexOf(light[1]!);
      if (point) result.push({ coordinates: point, coordinateSpan: { start, end: start + light[1]!.length }, name: 'Tower', shape: 'unknown', grouped: false, standalone: false });
    }
  }
  if (parts.some(part => !!part.closing)) for (const point of result) point.preserveText = true;
  results.set(record, result);
  return result;
}
function parseObstacle(body: string, offset: number, record: NotamRecord, references?: NotamAreaReferences): { point: NotamObstacle; remainder?: { text: string; lighting: boolean } } | undefined {
  if (body.length > 64 * 1024) return undefined;
  const original = body.replace(/\s+/g, ' ').trim(), text = original.toUpperCase();
  if (text.length !== original.length) return undefined;
  // A farm/area/boundary's coordinate is not an individual obstacle position.
  if (/\b(?:AREA|RADIUS|FARM|FARMS|BTN|BETWEEN|WITHIN)\b/.test(text)) return undefined;
  const candidate = /\b\d{4,9}(?:\.\d+)?[NSM]\s*\/?\s*\d{5,10}(?:\.\d+)?[EW]?(?=\s|[().,;]|$)/gi;
  const points = [...text.matchAll(candidate)], sourcePoints = [...body.matchAll(candidate)];
  if (points.length !== 1 || sourcePoints.length !== 1) return undefined;
  const point = points[0]!;
  const token = coordinateToken(text.slice(point.index));
  const coordinates = token && (Array.isArray(token.location) ? token.location : resolveCoordinate(token.location, record, references));
  if (!coordinates) return undefined;
  const prefix = text.slice(0, point.index);
  const kind = obstacleKind(prefix);
  if (!kind) return undefined;
  let cursor = point.index + point[0].length;
  cursor += obstacleAnnotation(text.slice(cursor));
  const heights = obstacleHeights(text.slice(cursor));
  if (!heights) return undefined;
  const { elevationMslFt, heightAglFt } = heights;
  const start = offset + sourcePoints[0]!.index;
  return { point: { coordinates, coordinateSpan: { start, end: start + sourcePoints[0]![0].length }, ...(token?.recovered ? { recovered: true } : {}), name: kind.name,
    ...(kind.preserveText || !heights.complete ? { preserveText: true } : {}),
    ...(elevationMslFt === undefined ? {} : { elevationMslFt }), ...(heightAglFt === undefined ? {} : { heightAglFt }),
    shape: heightAglFt === undefined ? 'unknown' : kind.name.startsWith('Wind') ? 'wind' : heightAglFt >= 1000 ? 'tall' : 'low',
    grouped: kind.grouped, standalone: true },
    // Unqualified source values remain in the reader; only explicitly known/unknown heights move into labels.
    ...(!token?.recovered && !kind.preserveText && heights.complete ? { remainder: {
      text: original.slice(cursor + heights.length).trim(), lighting: kind.lighting } } : {}) };
}

/** Only the validated location description is represented by the point symbol. */
export function mappedObstacleRemainder(record: NotamRecord): string | undefined {
  notamObstacles(record);
  const remainder = remainders.get(record);
  if (!remainder) return undefined;
  // Only location is represented by the map. Status and qualifications always
  // remain in the body, independently of which summary badges are displayed.
  return `${remainder.lighting ? 'LGT ' : ''}${remainder.text}`.trim();
}

export function notamObstacleFeatures(records: readonly NotamRecord[], now: number, references?: NotamAreaReferences): NotamObstacleCollection {
  const features: NotamObstacleCollection['features'] = [];
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.id) || ['cancelled', 'cancellation'].includes(record.lifecycle)) continue;
    seen.add(record.id);
    const obstacles = notamObstacles(record, references), timing = notamValidity(record, now);
    if (timing === 'past end') continue;
    const qualifier = timing === 'within interval' ? '' : `\n${timing.replace(/^./, char => char.toUpperCase())}`;
    for (const [index, obstacle] of obstacles.entries()) features.push({ type: 'Feature', id: `${record.id}:${index}`, geometry: { type: 'Point', coordinates: obstacle.coordinates }, properties: {
      noticeId: record.id, icon: `notam-obstacle-${obstacle.shape}-${obstacle.grouped ? 'group' : 'single'}`, shape: obstacle.shape,
      // Match DOF's MSL (AGL) feet convention; the warm color identifies the preview.
      label: `${obstacle.name}${obstacle.recovered ? '\nRecovered coordinate — check source' : ''}\n${obstacle.elevationMslFt ?? '?'} (${obstacle.heightAglFt ?? '?'})${qualifier}`,
      ...(obstacle.elevationMslFt === undefined ? {} : { elevationMslFt: obstacle.elevationMslFt }), timing,
    } });
  }
  return { type: 'FeatureCollection', features };
}
