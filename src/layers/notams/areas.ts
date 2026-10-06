import type { NotamRecord } from '@zlayer/contracts';
import { circle, corridor, polygon, arc } from './area-geometry';
import { localNotamContent, parseNotam } from './parser';
import type { NotamCoordinate as Point } from './coordinates';
import { coordinateToken, resolveCoordinate, type CoordinateRecovery } from './coordinate-recovery';
import type { NotamAreaReference, NotamAreaReferences } from './area-references';
import { notamScopes } from './clauses';
import { notamParts, maskNotamParts } from './multipart';
import { areaTail } from './area-tail';

export type NotamArea = {
  polygons: Point[][][]; labelPosition: Point; label: string; outer: boolean;
  /** Keep source qualifications, repaired tokens and altitude tiers visible after map acknowledgment. */
  preserveText?: boolean;
  recovered?: boolean;
  /** Exact location prose represented by this geometry, in parseNotam(record).body. */
  span: { start: number; end: number };
};
type Location = Point | NotamAreaReference | CoordinateRecovery;
type AreaArc = { after: number; center: NotamAreaReference; radius: number; clockwise: boolean };
export type NotamAreaDefinition = Omit<NotamArea, 'polygons' | 'labelPosition'> & (
  | { kind: 'circle'; locations: [Location]; radius: number; halfWidthNm?: never; parts?: never; arcs?: never }
  | { kind: 'polygon'; locations: Location[]; arcs?: AreaArc[]; radius?: never; halfWidthNm?: never; parts?: never }
  | { kind: 'corridor'; locations: Location[]; halfWidthNm: number; radius?: never; parts?: never; arcs?: never }
  | { kind: 'multiple'; locations: Location[]; parts: NotamAreaDefinition[]; radius?: never; halfWidthNm?: never; arcs?: never }
);
const definitions = new WeakMap<NotamRecord, NotamAreaDefinition | null>();
const cache = new WeakMap<NotamRecord, NotamArea | null>();
const referenceCaches = new WeakMap<NotamAreaReferences, WeakMap<NotamRecord, NotamArea | null>>();
// Only published plain-language/F-R-D location annotations belong to the geometry.
const annotation = /^(?:\s*\((?:[.\d]+\s*(?:NM\s*)?(?:[NSEW]{1,3}|NORTH|SOUTH|EAST|WEST)\s+[A-Z0-9]+|[A-Z0-9]{2,5}\s*\d{6}(?:\.\d+)?|(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*\d)[A-Z0-9]{2,5}|(?!(?:EXC|ARC|NOT|ALL|OUT|LGT|ABV|BLW|MSL|AGL|AND|UNL)\b)[A-Z]{3}|[.\d]+\s*(?:NM|FT)\s+[NSEW]{1,3}\s+(?:APCH\s+)?END\s+RWY\s+\d{2}[LRC]?|[A-Z -]+ (?:ATOLL|ISLAND))\s*\))?/;
const number = '(?:\\d+(?:\\.\\d+)?|\\.\\d+)';
const radiusPattern = new RegExp(`^(?:A\\s+)?(${number})\\s*(?:NMR?|NAUTICAL MILES?)\\s+(?:(?:OF\\s+)?RADIUS(?:\\s+(?:OF|CENTERED (?:AT|ON)))?|OF)\\s*`);
const corridorPattern = new RegExp(`^(${number})\\s*NM\\s+EITHER SIDE OF (?:A )?LINE(?: FM| FROM)?\\s+`);

function locationAt(text: string): { location: Location; length: number; recovered?: boolean } | undefined {
  const point = coordinateToken(text);
  if (point) return point;
  const frd = /^([A-Z0-9]{2,5})\/(\d{3}(?:\.\d+)?)\/(\d+(?:\.\d+)?)\b/.exec(text)
    ?? /^([A-Z0-9]{2,5}?)\s*(\d{3})(\d{3}(?:\.\d+)?)\b/.exec(text);
  if (frd) {
    const radial = Number(frd[2]), distanceNm = Number(frd[3]);
    return radial <= 360 && distanceNm >= 0 && distanceNm <= 600
      ? { location: { ident: frd[1]!, radial: radial % 360, distanceNm }, length: frd[0].length } : undefined;
  }
  const named = /^([A-Z0-9]{2,5})(?:\s+(VOR\/DME|VORTAC|VOR|AIRPORT|ARPT))?(?=\s|[(),.]|$)/.exec(text);
  if (!named || ['SFC', 'POINT', 'THE', 'TO', 'AREA'].includes(named[1]!)) return;
  return { location: { ident: named[1]!, ...(named[2] ? { kind: /^(?:AIRPORT|ARPT)$/.test(named[2]) ? 'airport' as const : 'navaid' as const } : {}) }, length: named[0].length };
}

function areaLabel(header: string): string {
  header = header.replace(/\s+/g, ' ');
  if (/\b(?:ADS-[BR]|TIS-B|FIS-B)\b/.test(header) && !/\bGPS\b/.test(header)) return 'ADS-B services may be unavailable';
  if (/^SVC\b/.test(header)) return 'ATC weather advisory service';
  if (/WIND TURBINE FARM/.test(header)) return 'Wind turbine farm';
  if (/\bLASER\b/.test(header)) return 'Laser activity';
  if (/SPACE REENTRY/.test(header)) return 'Space reentry/recovery';
  if (/\bSTNR ALT RESERVATION\b|ATC ASSIGNED AIRSPACE/.test(header)) return 'Airspace reservation';
  if (/\bGPS\b/.test(header)) return /MAY NOT BE (?:AVBL|AVAILABLE)/.test(header) ? 'GPS may be unavailable'
    : /\bUNREL(?:IABLE)?\b/.test(header) ? 'GPS unreliable' : /\bUNAVBL\b|NOT (?:AVBL|AVAILABLE)/.test(header) ? 'GPS unavailable' : 'GPS notice';
  for (const [pattern, label] of [[/\bUAS\b/, 'UAS'], [/\bPJE\b/, 'Parachute activity'], [/\bFLTCK\b/, 'Flight check'],
    [/CONTROLLED BURN/, 'Controlled burn'], [/\bROCKET\b/, 'Rocket activity'], [/\bBALLOON\b/, 'Balloon activity'],
    [/\bAEROBATIC\b/, 'Aerobatic activity']] as const) if (pattern.test(header)) return label;
  return /^OBST\b/.test(header) ? 'Obstruction area' : 'Airspace activity';
}

const introduction = /\b(?:AREA\s+IS\s+DEFINED\s+AS\s+|HAZARD\s+AREA\s+DEFINED\s+AS\s+|WI(?:THIN)?\s+(?:AN?\s+)?AREA\s+(?:DEFINED(?:\s+AS)?|OF)\s+|WI(?:THIN)?\s+(?:A\s+)?(?=[.\d]+\s*(?:NM|NAUTICAL MILES?)\s+RADIUS))/gi;

function parseDefinition(record: NotamRecord): NotamAreaDefinition | undefined {
  const body = parseNotam(record).body;
  if (body.length > 64 * 1024) return undefined;
  // The persistent graphical layer owns TFRs; do not add a second activity footprint.
  if (/\bTFR\b|TEMPORARY\s+FLIGHT\s+RESTRICTION/i.test(body)) return undefined;
  const transport = notamParts(body);
  if (!transport) return;
  const source = maskNotamParts(body, transport), scopes = notamScopes(source);
  const starts = [...source.matchAll(introduction)];
  if (!scopes || !starts.length || starts.length > 16 || starts.some(start =>
    !scopes.some(scope => scope.state === 'operative' && start.index >= scope.start && start.index + start[0].length <= scope.end))) return;
  if (starts.length > 1) {
    const offsets = starts.map((start, i) => i === 0 ? 0 : start.index -
      (/\b(?:(?:AIRSPACE )?UAS|SPEEDAIR (?:NORTH|CENTRAL|SOUTH)|THE (?:FAIRING|SECOND STAGE))\s*$/i
        .exec(source.slice(starts[i - 1]!.index, start.index))?.[0].length ?? 0));
    const parts = starts.map((_, i) => {
      const offset = offsets[i]!;
      return parseArea(record, source.slice(offset, offsets[i + 1]), offset, true, i < starts.length - 1);
    });
    if (parts.some(part => !part)) return;
    const complete = parts as NotamAreaDefinition[];
    return { kind: 'multiple', locations: complete.flatMap(part => part.locations), parts: complete, outer: false, preserveText: true,
      label: 'Multiple activity areas', span: { start: starts[0]!.index, end: body.length } };
  }
  return parseArea(record, source, 0, transport.some(part => !!part.closing));
}

/** One bounded boundary cursor. Document scope and transport have already been proven. */
function parseArea(record: NotamRecord, body: string, sourceOffset: number, multipart: boolean, followedByArea = false): NotamAreaDefinition | undefined {
  let original = localNotamContent(body, record).trimStart();
  const identity = /^([A-Z0-9]{3,4})\s+/.exec(original);
  if (identity && [...record.locations, ...record.icaoLocations].includes(identity[1]!)) original = original.slice(identity[0].length);
  const content = original.toUpperCase();
  // Case folding must preserve offsets into the original source text.
  if (content.length !== original.length) return undefined;
  const start = new RegExp(introduction.source, 'i').exec(content);
  if (!start) return undefined;
  const header = content.slice(0, start.index).replace(/\s+/g, ' ').trimStart();
  if (header && !/^(?:UAS|AIRSPACE|[A-Z]{2}\.\.AIRSPACE|NAV GPS(?:\/GNSS)?|OBST|SVC|ADS-B|FLT INFO (?:SER|SERVICE) BCST|UNMANNED ACFT|PJE WILL TAKE PLACE|MIL OPS WILL BE CONDUCTED|STNR ALT RESERVATION)\b/.test(header) &&
      !/^[A-Z .'-]+, [A-Z]{2}\.\.LASER (?:RESEARCH|LGT DEMONSTRATION)\b/.test(header) &&
      !/^[A-Z0-9 .-]{1,100}\bMIL OPS(?: IN [A-Z ]+)? $/.test(header) &&
      !/THE U.S. NAVY PLANS MULTIPLE SPHERE LAUNCHES $/.test(header) &&
      !/^(?:SPEEDAIR (?:NORTH|CENTRAL|SOUTH)|THE (?:FAIRING|SECOND STAGE)) $/.test(header) &&
      !/^THE SPEEDAIR BOUNDARIES HAVE EXTENDED TO THE WEST\. DUE TO ACFT MANEUVERING, THE FOLLOWING AREAS ARE NOTAMED AT THE TIMES INDICATED: SPEEDAIR NORTH\/CENTRAL\/SOUTH\. SPEEDAIR NORTH $/.test(header) &&
      !/^THE KOREA AEROSPACE RESEARCH INSTITUTE HAS PLANNED A SPACE VEHICLE LAUNCH\. DEBRIS FROM THIS LAUNCH WILL FALL WI TWO SEPARATE AREAS\. THE FAIRING $/.test(header)) return undefined;
  const geometryStart = start.index + start[0].length, rest = content.slice(geometryStart);
  const radiusMatch = radiusPattern.exec(rest);
  const corridorMatch = corridorPattern.exec(rest);
  const halfWidthNm = corridorMatch ? Number(corridorMatch[1]) : undefined;
  if (halfWidthNm !== undefined && !(halfWidthNm > 0 && halfWidthNm <= 100)) return;
  let radius = radiusMatch ? Number(radiusMatch[1]) : undefined;
  if (radius !== undefined && !(radius > 0 && radius <= 600)) return undefined;
  let end = radiusMatch?.[0].length ?? corridorMatch?.[0].length ?? 0;
  const locations: Location[] = [];
  const arcs: AreaArc[] = [];
  let preserveSource = multipart;
  let recovered = false;
  // Bounded cursor states: location -> optional annotation -> connector/closure -> altitude.
  // Every transition consumes the next token; never collect scattered coordinates from prose.
  while (locations.length <= 64) {
    const next = locationAt(rest.slice(end));
    if (!next) return undefined;
    locations.push(next.location); end += next.length;
    if (next.recovered) { preserveSource = true; recovered = true; }
    const suffix = rest.slice(end);
    const note = annotation.exec(suffix)![0];
    if (note) end += note.length;
    else {
      // Damaged redundant distance annotations never replace the explicit vertex.
      const redundant = /^\s*\((?![^)]*\b(?:EXC|EXCEPT|ONLY|OUTSIDE|NOT|UNLESS|IF)\b)[.\d]+(?:NM|NW)?\s*(?:[NSEW]{1,3})?\s*[A-Z0-9]{0,5}\s*\)/.exec(suffix);
      if (redundant && Array.isArray(next.location)) { end += redundant[0].length; preserveSource = true; }
    }
    if (radius !== undefined) break;
    const closure = /^\s*(?:THENCE\s+[NSEW]\s+)?TO\s+(?:THE\s+)?POINT\s+OF\s+(?:ORIGIN|ORGIN)\b/.exec(rest.slice(end));
    if (closure) { end += closure[0].length; break; }
    const arcMatch = /^\s+THENCE\s+(CLOCKWISE|COUNTERCLOCKWISE)\s+ALONG\s+THE\s+([A-Z0-9]{2,5})\s+(\d+(?:\.\d+)?)\s*NM\s+ARC\s+TO\s+/.exec(rest.slice(end));
    if (arcMatch) {
      if (halfWidthNm !== undefined) return; // Curved centerline corridors have no supported width construction.
      arcs.push({ after: locations.length - 1, center: { ident: arcMatch[2]!, kind: 'navaid' },
        radius: Number(arcMatch[3]), clockwise: arcMatch[1] === 'CLOCKWISE' });
      end += arcMatch[0].length; continue;
    }
    const to = /^\s*TO\s+/.exec(rest.slice(end)) ??
      (start[0].startsWith('AREA IS') && /^\s+(?=\d{4,6}[NS])/.exec(rest.slice(end)));
    if (!to) {
      if (halfWidthNm !== undefined && locations.length >= 2) break;
      if (locations.length < 4 || JSON.stringify(locations[0]) !== JSON.stringify(locations.at(-1))) return undefined;
      break;
    }
    end += to[0].length;
  }
  if (locations.length > 64 || radius === undefined && locations.length < (halfWidthNm === undefined ? 3 : 2)) return undefined;
  const tail = areaTail(rest.slice(end), header, radius, followedByArea);
  if (!tail) return;
  const { outer, labelHeight, runwaySector } = tail;
  const preserveText = preserveSource || tail.preserveText;
  radius = tail.radius;
  const offset = sourceOffset + body.length - original.length;
  const metadata = { ...(recovered ? { recovered } : {}), outer, ...(preserveText ? { preserveText } : {}),
    label: `${areaLabel(header)}${recovered ? '\nRecovered coordinate — check source' : ''}${outer ? '\nOuter extent' : ''}${runwaySector ? '\nSee runway-sector qualifications' : ''}${labelHeight ? `\n${labelHeight}` : ''}`,
    span: { start: offset + start.index, end: offset + geometryStart + end } };
  if (radius !== undefined) return { ...metadata, kind: 'circle', locations: [locations[0]!], radius };
  if (halfWidthNm !== undefined) return { ...metadata, kind: 'corridor', locations, halfWidthNm };
  return { ...metadata, kind: 'polygon', locations, ...(arcs.length ? { arcs } : {}) };
}

/** Recognized source syntax; geometry still requires unambiguous reference resolution and polygon validation. */
export function notamAreaDefinition(record: NotamRecord): NotamAreaDefinition | undefined {
  if (!definitions.has(record)) definitions.set(record, parseDefinition(record) ?? null);
  return definitions.get(record) ?? undefined;
}

export function notamArea(record: NotamRecord, references?: NotamAreaReferences): NotamArea | undefined {
  let results = cache;
  if (references) {
    let current = referenceCaches.get(references);
    if (!current) { current = new WeakMap(); referenceCaches.set(references, current); }
    results = current;
  }
  if (!results.has(record)) {
    const definition = notamAreaDefinition(record);
    let area: NotamArea | undefined;
    if (definition) area = resolveArea(definition, record, references);
    results.set(record, area ?? null);
  }
  return results.get(record) ?? undefined;
}

function resolveArea(definition: NotamAreaDefinition, record: NotamRecord, references?: NotamAreaReferences): NotamArea | undefined {
  if (definition.kind === 'multiple') {
    const parts = definition.parts.map(part => resolveArea(part, record, references));
    if (parts.some(part => !part)) return;
    const all = parts as NotamArea[], recovered = all.some(part => part.recovered);
    return { polygons: all.flatMap(part => part.polygons), labelPosition: all[0]!.labelPosition,
      span: definition.span, label: definition.label + (recovered ? '\nRecovered coordinate — check source' : ''),
      outer: false, preserveText: true, ...(recovered ? { recovered } : {}) };
  }
  const points = definition.locations.map(location => Array.isArray(location) ? location
    : 'candidates' in location ? resolveCoordinate(location, record, references) : references?.(location, record));
  if (!points.every((point): point is Point => !!point)) return;
  const boundary: Point[] = [];
  for (let i = 0; i < points.length; i++) {
    boundary.push(points[i]!);
    const segment = definition.arcs?.find(a => a.after === i);
    if (segment) {
      const center = references?.(segment.center, record);
      const samples = center && points[i + 1] && arc(points[i]!, points[i + 1]!, center, segment.radius, segment.clockwise);
      if (!samples) return;
      boundary.push(...samples.slice(1, -1));
    }
  }
  const ring = definition.kind === 'circle' ? circle(points[0]!, definition.radius) : definition.kind === 'polygon' ? polygon(boundary) : undefined;
  const polygons = definition.kind === 'corridor' ? corridor(points, definition.halfWidthNm) : ring ? [[ring]] : undefined;
  if (!polygons) return;
  return { polygons, labelPosition: points[0]!, span: definition.span, label: definition.label, outer: definition.outer,
    ...(definition.recovered ? { recovered: true } : {}), ...(definition.preserveText ? { preserveText: true } : {}) };
}
