import { readPirepField } from './text';
import { localDescription, radialDistance, radialFields } from './location-grammar';

export type Distance = { value: number; unit: 'NM' | 'SM'; distanceNm: number; assumedUnit?: true };
export type Radial = { radial: number; distanceNm: number; recovered?: true };
export type PirepLocationReference = { ident: string; airportOnly?: true } & (
  { kind: 'reference' } | ({ kind: 'offset'; bearing: 'true' | 'magnetic' } & Radial)
  | { kind: 'reference-only'; radial: number; distanceNm?: number }
);
export type PirepLocationPoint = PirepLocationReference | { kind: 'coordinate'; coordinate: [number, number] }
  | { kind: 'alternatives'; options: PirepLocationReference[] };
export type LocalDescription = { kind: 'compass'; distance: Distance; direction: string; radial: number }
  | { kind: 'distance'; distance: Distance } | { kind: 'approach'; name: string; distance?: Distance }
  | { kind: 'departure'; runway: string };
export type PirepLocationRecovery = {
  kind: 'recovery'; text: string; anchor: { ident: string; source: 'explicit' | 'reporting-station' };
  description: LocalDescription | ({ kind: 'radial' } & Radial);
};
type Rejected = { kind: 'rejected'; reason: string };
export type Read<T> = { kind: 'unrecognized' } | Rejected | { kind: 'parsed'; value: T };
export type PirepLocation = { kind: 'points'; text: string; points: PirepLocationPoint[] }
  | PirepLocationRecovery
  | { kind: 'recovery-options'; text: string; options: PirepLocationRecovery[] }
  | { kind: 'identifier-or-recovery'; text: string; ident: string; fallback: PirepLocationRecovery | Rejected };
export type PirepLocationRead = { kind: 'parsed'; location: PirepLocation }
  | { kind: 'unrecognized' | 'rejected'; reason: string };

const noMatch = { kind: 'unrecognized' } as const;
const reject = (reason: string): Rejected => ({ kind: 'rejected', reason });
const parsed = <T>(value: T): Read<T> => ({ kind: 'parsed', value });
// Product recovery limit for direction-unknown distance-only descriptions.
const MAX_DISTANCE_ONLY_NM = 5;

function validIdent(ident: string): boolean {
  return /^(?:[A-Z0-9]{3,4}|[A-Z]{5})$/.test(ident) && /[A-Z]/.test(ident) && !['UNKN', 'UNK'].includes(ident);
}

/** Only unrecognized syntax may try an explicit anchor. A recognized description
 * with missing context or rejected policy must never become another location. */
function localLocation(text: string, station?: string): Read<PirepLocationRecovery> {
  const words = text.split(/\s+/);
  let result: Read<LocalDescription> = noMatch, ident = station;
  let source: 'explicit' | 'reporting-station' = 'reporting-station';
  let state: 'whole' | 'suffix' | 'prefix' | 'anchor' = 'whole';
  while (state !== 'anchor') {
    switch (state) {
      case 'whole':
        result = localDescription(text);
        state = result.kind === 'unrecognized' ? 'suffix' : 'anchor'; break;
      case 'suffix': {
        source = 'explicit';
        if (words.length > 1 && /^[A-Z0-9]{3,5}$/.test(words.at(-1)!)) {
          ident = words.at(-1);
          const end = ['OF', 'AT'].includes(words.at(-2)!) ? -2 : -1;
          result = localDescription(words.slice(0, end).join(' '));
        }
        state = result.kind === 'unrecognized' ? 'prefix' : 'anchor'; break;
      }
      case 'prefix':
        if (words.length > 1 && /^[A-Z0-9]{3,5}$/.test(words[0]!)) {
          ident = words[0]; result = localDescription(words.slice(1).join(' '));
        }
        state = 'anchor'; break;
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

/** A missing separator can yield multiple compass/reference splits (3NEABC:
 * N of EABC or NE of ABC). Keep every whole-field reading for reference lookup. */
function compactCompassLocation(text: string): Read<PirepLocation> {
  const options: PirepLocationRecovery[] = [];
  let rejected: Rejected | undefined;
  for (const length of [3, 4, 5]) {
    const ident = text.slice(-length), prefix = text.slice(0, -length);
    if (!validIdent(ident) || !/[A-Z]$/.test(prefix)) continue;
    const result = localDescription(prefix);
    if (result.kind === 'rejected') rejected = result;
    if (result.kind === 'parsed' && result.value.kind === 'compass') {
      options.push({ kind: 'recovery', text, anchor: { ident, source: 'explicit' }, description: result.value });
    }
  }
  return options.length ? parsed({ kind: 'recovery-options', text, options }) : rejected ?? noMatch;
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
    else {
      if (offset.kind === 'rejected') rejected = offset;
      // A syntactically complete reference plus radial can still identify an
      // anchor when its offset cannot identify an observation point.
      const remainder = text.slice(length).trimStart();
      const partial = radialFields(remainder);
      const procedureWord = ['DEP', 'ILS', 'LOC', 'GPS', 'VOR', 'NDB', 'RNAV', 'FINAL'].includes(ident) && /^\s/.test(text.slice(length));
      if (partial && !procedureWord) options.push({ kind: 'reference-only', ident, radial: partial.radial,
        ...(partial.distance === undefined ? {} : { distanceNm: Number(partial.distance) }) });
    }
  }
  // A complete standard encoding owns its syntax. Incomplete alternative splits
  // cannot reinterpret an ordinary bearing just because its identity is absent.
  if (options.some(point => referenceRank(point) === 0)) {
    for (let i = options.length - 1; i >= 0; i--) if (options[i]!.kind === 'reference-only') options.splice(i, 1);
  }
  options.sort((a, b) => referenceRank(a) - referenceRank(b));
  return options.length > 1 ? parsed({ kind: 'alternatives', options }) : options[0] ? parsed(options[0]) : rejected ?? noMatch;
}

export function referenceRank(point: PirepLocationReference): number {
  return point.kind === 'reference-only' ? 2 : point.kind === 'offset' && point.recovered ? 1 : 0;
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

/** Whole-field machine: literal → standard → local → compact → bare radial.
 * Only an unrecognized production advances; rejection commits its meaning.
 * Explicit alternatives survive until published-reference resolution. */
export function readPirepLocation(raw: string): PirepLocationRead {
  const unsupported = { kind: 'unrecognized', reason: 'Location format not recognized' } as const;
  const field = readPirepField(raw, 'OV');
  if (!field) return reject('Invalid PIREP header or duplicate /OV location');
  const { value: text, station } = field;
  if (text === undefined) return reject('No /OV location supplied');
  if (!text || text.length > 512) return reject('Empty or oversized /OV location');
  const literal = validIdent(text);
  const point = (): PirepLocation => ({ kind: 'points', text, points: [{ kind: 'reference', ident: text }] });
  let state: 'literal' | 'standard' | 'local' | 'compact' | 'radial' = 'literal';
  while (true) {
    switch (state) {
      case 'literal':
        if (literal && /^[A-Z]/.test(text)) return { kind: 'parsed', location: point() };
        state = literal ? 'local' : 'standard'; break;
      case 'standard': {
        const result = standardLocation(text);
        if (result.kind === 'parsed') return { kind: 'parsed', location: result.value };
        if (result.kind === 'rejected') return result;
        state = 'local'; break;
      }
      case 'local': {
        const result = localLocation(text, station);
        if (literal) return { kind: 'parsed', location: result.kind === 'unrecognized' ? point()
          : { kind: 'identifier-or-recovery', text, ident: text, fallback: result.kind === 'parsed' ? result.value : result } };
        if (result.kind === 'parsed') return { kind: 'parsed', location: result.value };
        if (result.kind === 'rejected') return result;
        state = 'compact'; break;
      }
      case 'compact': {
        const result = compactCompassLocation(text);
        if (result.kind === 'parsed') return { kind: 'parsed', location: result.value };
        if (result.kind === 'rejected') return result;
        state = 'radial'; break;
      }
      case 'radial': {
        const result = radialDistance(text);
        if (result.kind === 'rejected') return result;
        if (result.kind === 'unrecognized') return unsupported;
        if (!station || !validIdent(station)) return reject('Reporting airport unavailable');
        return { kind: 'parsed', location: { kind: 'recovery', text, anchor: { ident: station, source: 'reporting-station' },
          description: { kind: 'radial', ...result.value } } };
      }
    }
  }
}
