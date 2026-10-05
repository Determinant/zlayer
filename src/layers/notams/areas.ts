import type { NotamRecord } from '@zlayer/contracts';
import { distanceNm, greatCircleCoordinates } from '@zlayer/domain';
import { localNotamContent, parseNotam } from './parser';
import { NOTAM_COORDINATE, notamCoordinate, type NotamCoordinate as Point } from './coordinates';

export type NotamArea = {
  ring: Point[]; labelPosition: Point; label: string; outer: boolean;
  /** Exact location prose represented by this geometry, in parseNotam(record).body. */
  span: { start: number; end: number };
};
const cache = new WeakMap<NotamRecord, NotamArea | null>();
const radians = Math.PI / 180;
const altitude = /^(?:ACT\s+)?((?:SFC|FL\d+|\d+(?:\.\d+)?\s*FT)\s*-\s*(?:UNL|FL\d+|\d+(?:\.\d+)?\s*FT)(?:\s+(?:AGL|MSL))?)(?=\s|[.,]|$)/;
// Only published plain-language/F-R-D location annotations belong to the geometry.
const annotation = /^(?:\s*\((?:[.\d]+\s*(?:NM\s*)?[NSEW]{1,3}\s+[A-Z0-9]+|[A-Z0-9]{2,5}\s*\d{6}(?:\.\d+)?)\))?/;

function circle(center: Point, radius: number): Point[] | undefined {
  if (!(radius > 0 && radius <= 600)) return undefined;
  const distance = radius / 3440.065, lat = center[1] * radians;
  // At most 0.01 NM radial chord error, with bounded preparation for broad GPS footprints.
  const count = Math.min(720, Math.max(64, Math.ceil(Math.PI / Math.acos(Math.max(-1, 1 - .01 / radius)))));
  const ring: Point[] = Array.from({ length: count }, (_, i) => {
    const bearing = -i * 2 * Math.PI / count;
    const next = Math.asin(Math.sin(lat) * Math.cos(distance) + Math.cos(lat) * Math.sin(distance) * Math.cos(bearing));
    const lon = center[0] + Math.atan2(Math.sin(bearing) * Math.sin(distance) * Math.cos(lat), Math.cos(distance) - Math.sin(lat) * Math.sin(next)) / radians;
    return [lon, next / radians];
  });
  if (ring.some(point => Math.abs(point[1]) > 85)) return undefined;
  ring.push([...ring[0]!]); return ring;
}

/** A closed, simple polygon only; arcs, corridors, omissions and self crossings stay prose. */
function polygon(points: Point[]): Point[] | undefined {
  if (points.length < 3 || points.length > 64) return undefined;
  const ring = points.map(([lon, lat]): Point => [points[0]![0] + ((lon - points[0]![0] + 540) % 360 - 180), lat]);
  const same = (a: Point, b: Point) => a[0] === b[0] && a[1] === b[1];
  if (same(ring[0]!, ring.at(-1)!)) ring.pop();
  if (ring.length < 3 || new Set(ring.map(p => p.join(','))).size !== ring.length || ring.some(p => Math.abs(p[1]) > 85) ||
      Math.max(...ring.map(p => p[0])) - Math.min(...ring.map(p => p[0])) >= 180) return undefined;
  ring.push([...ring[0]!]);
  const cross = (a: Point, b: Point, c: Point) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  for (let i = 0; i < ring.length - 1; i++) for (let j = i + 2; j < ring.length - 1; j++) {
    if (i === 0 && j === ring.length - 2) continue;
    const a = ring[i]!, b = ring[i + 1]!, c = ring[j]!, d = ring[j + 1]!;
    if (cross(a, b, c) * cross(a, b, d) <= 0 && cross(c, d, a) * cross(c, d, b) <= 0) return undefined;
  }
  const area = ring.slice(1).reduce((sum, p, i) => sum + ring[i]![0] * p[1] - p[0] * ring[i]![1], 0);
  if (Math.abs(area) < 1e-10) return undefined;
  if (area < 0) ring.reverse();
  if (ring.slice(1).some((p, i) => distanceNm(ring[i]!, p) > 600)) return undefined;
  const detailed = ring.slice(1).flatMap((p, i) => greatCircleCoordinates(ring[i]!, p).slice(0, -1))
    .map(([lon, lat]): Point => [ring[0]![0] + ((lon - ring[0]![0] + 540) % 360 - 180), lat]);
  if (detailed.some(p => Math.abs(p[1]) > 85)) return undefined;
  detailed.push([...detailed[0]!]); return detailed;
}

function areaLabel(header: string): string {
  if (/\bGPS\b/.test(header)) return /MAY NOT BE (?:AVBL|AVAILABLE)/.test(header) ? 'GPS may be unavailable'
    : /\bUNREL(?:IABLE)?\b/.test(header) ? 'GPS unreliable' : /\bUNAVBL\b|NOT (?:AVBL|AVAILABLE)/.test(header) ? 'GPS unavailable' : 'GPS notice';
  for (const [pattern, label] of [[/\bUAS\b/, 'UAS'], [/\bPJE\b/, 'Parachute activity'], [/\bFLTCK\b/, 'Flight check'],
    [/CONTROLLED BURN/, 'Controlled burn'], [/\bROCKET\b/, 'Rocket activity'], [/\bBALLOON\b/, 'Balloon activity'],
    [/\bAEROBATIC\b/, 'Aerobatic activity']] as const) if (pattern.test(header)) return label;
  return /^OBST\b/.test(header) ? 'Obstruction area' : 'Airspace activity';
}

function parseArea(record: NotamRecord): NotamArea | undefined {
  const body = parseNotam(record).body;
  if (body.length > 64 * 1024) return undefined;
  // TFR boundaries/schedules belong to the persistent FAA graphical layer.
  if (/\bTFR\b|TEMPORARY FLIGHT RESTRICTION/.test(body)) return undefined;
  const content = localNotamContent(body, record);
  if (!/^(?:AIRSPACE|NAV GPS|OBST)\b/.test(content)) return undefined;
  const start = /\b(?:WI(?:THIN)?\s+AN?\s+AREA\s+DEFINED\s+AS\s+|WITHIN\s+(?:A\s+)?(?=[.\d]+\s*NM\s+RADIUS))/.exec(content);
  if (!start) return undefined;
  const header = content.slice(0, start.index);
  if (/\b(?:NOTE|ADD|DELETE|DISREGARD|EXC|EXCEPT|UNLESS|IF|WHEN)\b/.test(header)) return undefined;
  const geometryStart = start.index + start[0].length, rest = content.slice(geometryStart);
  const matches = [...rest.matchAll(NOTAM_COORDINATE)];
  if (!matches.length || matches.length > 64) return undefined;
  const first = matches[0]!, before = rest.slice(0, first.index);
  const radius = /^([.\d]+)\s*NM\s+RADIUS(?:\s+(?:OF|CENTERED AT))?\s*$/.exec(before);
  let end: number, ring: Point[] | undefined, labelPosition: Point;
  if (radius) {
    if (matches.length !== 1) return undefined;
    const center = notamCoordinate(first); if (!center) return undefined;
    ring = circle(center, Number(radius[1])); labelPosition = center;
    end = first.index + first[0].length;
    end += annotation.exec(rest.slice(end))![0].length;
    // A radius with a following boundary amendment is not a full circle.
    if (/^\s*(?:TO\b|THEN\b|EXC\b|EXCEPT\b)/.test(rest.slice(end))) return undefined;
  } else {
    if (before.trim()) return undefined;
    const points: Point[] = []; end = 0;
    for (const [i, match] of matches.entries()) {
      if (rest.slice(end, match.index).trim() !== (i ? 'TO' : '')) return undefined;
      const point = notamCoordinate(match); if (!point) return undefined;
      points.push(point); end = match.index + match[0].length;
      end += annotation.exec(rest.slice(end))![0].length;
    }
    const closure = /^\s+TO\s+(?:THE\s+)?POINT\s+OF\s+ORIGIN\b/.exec(rest.slice(end));
    const repeated = points.length > 3 && points[0]!.every((v, i) => v === points.at(-1)![i]);
    if (!closure && !repeated) return undefined;
    end += closure?.[0].length ?? 0;
    ring = polygon(points); labelPosition = points[0]!;
  }
  if (!ring) return undefined;
  const tail = rest.slice(end).trim(), outer = /\bGPS\b/.test(header) && /DECREASING IN AREA.*DECREASE IN ALTITUDE/s.test(tail);
  if (/\b(?:EXC|EXCEPT|EXCLUDING|INCLUDING|OUTSIDE|ARC|ARCS)\b|EITHER SIDE/.test(tail) ||
      /DECREASING IN AREA/.test(tail) && !outer) return undefined;
  // Retain all altitude-dependent GPS tiers and every operational qualification in prose.
  if (!altitude.test(tail) && !/^(?:ACT\b|[.,]|$)/.test(tail)) return undefined;
  const height = altitude.exec(tail)?.[1]?.replace(/\s+/g, ' ');
  const offset = body.indexOf(content);
  return { ring, labelPosition, outer, label: `${areaLabel(header)}${outer ? '\nOuter extent' : ''}${height ? `\n${height}` : ''}`,
    span: { start: offset + start.index, end: offset + geometryStart + end } };
}

export function notamArea(record: NotamRecord): NotamArea | undefined {
  if (!cache.has(record)) cache.set(record, parseArea(record) ?? null);
  return cache.get(record) ?? undefined;
}
