import { readPirepField } from './text';

type Distance = { value: number; unit: 'NM' | 'SM'; distanceNm: number };
type Radial = { radial: number; distanceNm: number; recovered?: true };
export type PirepLocationReference = { ident: string; airportOnly?: true } & (
  { kind: 'reference' } | ({ kind: 'offset'; bearing: 'true' | 'magnetic' } & Radial)
);
export type PirepLocationPoint = PirepLocationReference | { kind: 'coordinate'; coordinate: [number, number] }
  | { kind: 'alternatives'; options: PirepLocationReference[] };
type LocalDescription = { kind: 'compass'; distance: Distance; direction: string; radial: number }
  | { kind: 'distance'; distance: Distance } | { kind: 'approach'; name: string }
  | { kind: 'departure'; runway: string };
export type PirepLocationRecovery = {
  kind: 'recovery'; text: string; anchor: { ident: string; source: 'explicit' | 'reporting-station' };
  description: LocalDescription | ({ kind: 'radial' } & Radial);
};
type Rejected = { kind: 'rejected'; reason: string };
type Read<T> = { kind: 'unrecognized' } | Rejected | { kind: 'parsed'; value: T };
export type PirepLocation = { kind: 'points'; text: string; points: PirepLocationPoint[] }
  | PirepLocationRecovery
  | { kind: 'identifier-or-recovery'; text: string; ident: string; fallback: PirepLocationRecovery | Rejected };
export type PirepLocationRead = { kind: 'parsed'; location: PirepLocation }
  | { kind: 'unrecognized' | 'rejected'; reason: string };

const noMatch = { kind: 'unrecognized' } as const;
const reject = (reason: string): Rejected => ({ kind: 'rejected', reason });
const parsed = <T>(value: T): Read<T> => ({ kind: 'parsed', value });
const compass: Record<string, number> = { N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
  S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5 };
// Product recovery limit: bound the displacement of a direction-unknown marker.
const MAX_DISTANCE_ONLY_NM = 5;

function distance(value: string, units?: string): Read<Distance> {
  const amount = Number(value), unit = units === 'SM' ? 'SM' : 'NM';
  const distanceNm = amount * (unit === 'SM' ? 1609.344 / 1852 : 1);
  if (value.split('.')[0]!.length > 3 || !Number.isFinite(distanceNm) || distanceNm > 999) return reject('Location distance out of range');
  return parsed({ value: amount, unit, distanceNm });
}

/** Recognize the complete description before applying anchor or recovery policy.
 * A distance/unit owns its syntax, so MILES cannot split into MILE + S (south). */
function localDescription(text: string): Read<LocalDescription> {
  const only = /^(\d+(?:\.\d+)?|\.\d+)\s*(NM|SM|MILES?)$/.exec(text);
  if (only) {
    const result = distance(only[1]!, only[2]);
    return result.kind === 'parsed' ? parsed({ kind: 'distance', distance: result.value }) : result;
  }
  const forward = /^(\d+(?:\.\d+)?|\.\d+)\s*(NM|SM|MILES?)?\s*([A-Z][A-Z\s-]*)$/.exec(text);
  const reverse = forward ? null : /^([A-Z][A-Z\s-]*?)\s*(\d+(?:\.\d+)?|\.\d+)\s*(NM|SM|MILES?)?$/.exec(text);
  if (forward || reverse) {
    const direction = (forward?.[3] ?? reverse![1]!).replaceAll('NORTH', 'N').replaceAll('SOUTH', 'S')
      .replaceAll('EAST', 'E').replaceAll('WEST', 'W').replace(/[\s-]/g, '');
    if (Object.hasOwn(compass, direction)) {
      const result = distance(forward?.[1] ?? reverse![2]!, forward?.[2] ?? reverse?.[3]);
      return result.kind === 'parsed' ? parsed({ kind: 'compass', distance: result.value, direction, radial: compass[direction]! }) : result;
    }
  }
  const departure = /^(?:ON\s+)?(?:DEP|DEPARTURE)\s+(?:RWY\s*|RUNWAY\s*)?(\d{1,2})([LRC]?)$/.exec(text);
  if (departure) {
    if (Number(departure[1]) < 1 || Number(departure[1]) > 36) return reject('Departure runway out of range');
    return parsed({ kind: 'departure', runway: `${departure[1]!.padStart(2, '0')}${departure[2]}` });
  }
  const approach = /^(?:ON\s+)?(RNAV(?:\s*\((?:GPS|RNP)\))?|ILS(?:\s+OR\s+LOC)?|LOC(?:\/DME)?|GPS|VOR(?:\/DME)?|NDB|FINAL)(?:\s+([XYZ]))?\s*(?:(?:APCH|APPROACH)\s+)?(?:RWY\s*|RUNWAY\s*)?(\d{1,2})([LRC]?)(?:\s+(?:APCH|APPROACH))?$/.exec(text);
  if (!approach) return noMatch;
  if (Number(approach[3]) < 1 || Number(approach[3]) > 36) return reject('Approach runway out of range');
  return parsed({ kind: 'approach', name: `${approach[1]!.replace(/\s+/g, ' ')}${approach[2] ? ` ${approach[2]}` : ''} RWY ${approach[3]!.padStart(2, '0')}${approach[4]}` });
}

function validIdent(ident: string): boolean {
  return /^(?:[A-Z0-9]{3,4}|[A-Z]{5})$/.test(ident) && /[A-Z]/.test(ident) && !['UNKN', 'UNK'].includes(ident);
}

/** Only unrecognized syntax may try an explicit anchor. A recognized description
 * with missing context or rejected policy must never become another location. */
function localLocation(text: string, station?: string): Read<PirepLocationRecovery> {
  let result = localDescription(text), ident = station;
  let source: 'explicit' | 'reporting-station' = 'reporting-station';
  if (result.kind === 'unrecognized') {
    source = 'explicit';
    const suffix = /^(.*?)\s+(?:(?:OF|AT)\s+)?([A-Z0-9]{3,5})$/.exec(text);
    if (suffix) { result = localDescription(suffix[1]!); ident = suffix[2]; }
    if (result.kind === 'unrecognized') {
      const prefix = /^([A-Z0-9]{3,5})\s+(.+)$/.exec(text);
      if (prefix) { result = localDescription(prefix[2]!); ident = prefix[1]; }
    }
  }
  if (result.kind !== 'parsed') return result;
  if (!ident || !validIdent(ident)) return reject(source === 'explicit' ? 'Invalid location reference' : 'Reporting airport unavailable');
  const description = result.value;
  if (description.kind !== 'compass' && ident.length > 4) return reject('Location requires an airport reference');
  if (description.kind === 'distance' && description.distance.distanceNm > MAX_DISTANCE_ONLY_NM) {
    return reject(`Distance-only location exceeds ${MAX_DISTANCE_ONLY_NM} NM; direction unknown`);
  }
  return parsed({ kind: 'recovery', text, anchor: { ident, source }, description });
}

function radialDistance(text: string): Read<Radial> {
  // Keep the radial at three digits. Only distance padding varies.
  const match = /^(\d{3})\s*(\d{1,4})$/.exec(text);
  if (!match) return noMatch;
  if (Number(match[1]) > 360 || Number(match[2]) > 999) return reject('Location bearing or distance out of range');
  return parsed({ radial: Number(match[1]) % 360, distanceNm: Number(match[2]),
    ...(match[2]!.length === 3 ? {} : { recovered: true as const }) });
}

function referencePoint(text: string): Read<PirepLocationPoint> {
  if (validIdent(text)) return parsed({ kind: 'reference', ident: text });
  const options: PirepLocationReference[] = [];
  let rejected: Rejected | undefined;
  // Preserve possible identifier splits until published references disambiguate
  // them. A known reference with standard distance padding takes precedence.
  for (const length of [3, 4, 5]) {
    const ident = text.slice(0, length);
    if (!validIdent(ident)) continue;
    const offset = radialDistance(text.slice(length).trimStart());
    if (offset.kind === 'parsed') options.push({ kind: 'offset', ident, bearing: 'magnetic', ...offset.value });
    else if (offset.kind === 'rejected') rejected = offset;
  }
  options.sort((a, b) => Number(a.kind === 'offset' && !!a.recovered) - Number(b.kind === 'offset' && !!b.recovered));
  return options.length > 1 ? parsed({ kind: 'alternatives', options }) : options[0] ? parsed(options[0]) : rejected ?? noMatch;
}

function standardLocation(text: string): Read<PirepLocation> {
  const segments = text.split(/\s*[-–]\s*/);
  if (segments.length > 16) return reject('Location route exceeds 16 points');
  const points: PirepLocationPoint[] = [];
  for (const segment of segments) {
    const coordinate = /^(\d{2})(\d{2})([NS])\s*(\d{3})(\d{2})([EW])$/.exec(segment);
    if (coordinate) {
      const lat = Number(coordinate[1]) + Number(coordinate[2]) / 60;
      const lon = Number(coordinate[4]) + Number(coordinate[5]) / 60;
      if (Number(coordinate[2]) >= 60 || Number(coordinate[5]) >= 60 || lat > 90 || lon > 180) return reject('Location coordinates out of range');
      points.push({ kind: 'coordinate', coordinate: [lon * (coordinate[6] === 'W' ? -1 : 1), lat * (coordinate[3] === 'S' ? -1 : 1)] });
      continue;
    }
    const point = referencePoint(segment);
    if (point.kind !== 'parsed') return point;
    points.push(point.value);
  }
  return parsed({ kind: 'points', text, points });
}

/** Whole-field syntax recognition is separate from published reference lookup.
 * The only cross-grammar choice is an explicit identifier-or-recovery alternative. */
export function readPirepLocation(raw: string): PirepLocationRead {
  const unsupported = { kind: 'unrecognized', reason: 'Location format not recognized' } as const;
  const field = readPirepField(raw, 'OV');
  if (!field) return reject('Invalid PIREP header or duplicate /OV location');
  const { value: text, station } = field;
  if (text === undefined) return reject('No /OV location supplied');
  if (!text || text.length > 512) return reject('Empty or oversized /OV location');
  const literal = validIdent(text);
  const point = (): PirepLocation => ({ kind: 'points', text, points: [{ kind: 'reference', ident: text }] });
  // Letter-first compact forms such as W55 and GPS1 are published identifiers.
  if (literal && /^[A-Z]/.test(text)) return { kind: 'parsed', location: point() };
  // Standard coordinates, routes and reference/radial forms own their syntax.
  // For example, a latitude must not become a distance before an airport anchor.
  if (!literal) {
    const standard = standardLocation(text);
    if (standard.kind === 'parsed') return { kind: 'parsed', location: standard.value };
    if (standard.kind === 'rejected') return standard;
  }
  const local = localLocation(text, station);
  if (literal) return { kind: 'parsed', location: local.kind === 'unrecognized' ? point()
    : { kind: 'identifier-or-recovery', text, ident: text, fallback: local.kind === 'parsed' ? local.value : local } };
  if (local.kind === 'parsed') return { kind: 'parsed', location: local.value };
  if (local.kind === 'rejected') return local;
  const radial = radialDistance(text);
  if (radial.kind === 'rejected') return radial;
  if (radial.kind === 'parsed') {
    if (!station || !validIdent(station)) return reject('Reporting airport unavailable');
    return { kind: 'parsed', location: { kind: 'recovery', text, anchor: { ident: station, source: 'reporting-station' },
      description: { kind: 'radial', ...radial.value } } };
  }
  return unsupported;
}
