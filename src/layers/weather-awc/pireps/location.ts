import { readPirepField } from './text';

export type PirepLocationReference = {
  ident: string; radial?: number; distanceNm?: number; bearing?: 'true'; airportOnly?: boolean;
  recovered?: true;
};
export type PirepLocationPoint = { coordinate: [number, number] } | (PirepLocationReference & {
  alternatives?: PirepLocationReference[];
});
export type PirepLocation = {
  text: string; points: PirepLocationPoint[]; estimated?: string;
  offsetFallback?: { points: PirepLocationPoint[]; estimated: string };
};
export type PirepLocationRead = { location: PirepLocation } | { reason: string };

const compass: Record<string, number> = { N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
  S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5 };

/** A narrow recovery grammar for spoken-style offsets, not arbitrary prose.
 * Compass words describe geographic directions; unqualified distances use NM. */
function compassOffset(text: string) {
  const forward = /^(\d{1,3}(?:\.\d+)?|\.\d+)\s*(NM|SM|MILES?)?\s*([A-Z][A-Z\s-]*)$/.exec(text);
  const reverse = forward ? null : /^([A-Z][A-Z\s-]*?)\s*(\d{1,3}(?:\.\d+)?|\.\d+)\s*(NM|SM|MILES?)?$/.exec(text);
  if (!forward && !reverse) return;
  const direction = (forward?.[3] ?? reverse![1]!).replaceAll('NORTH', 'N').replaceAll('SOUTH', 'S')
    .replaceAll('EAST', 'E').replaceAll('WEST', 'W').replace(/[\s-]/g, '');
  if (!Object.hasOwn(compass, direction)) return;
  const distance = Number(forward?.[1] ?? reverse![2]), unit = (forward?.[2] ?? reverse?.[3]) === 'SM' ? 'SM' : 'NM';
  const distanceNm = distance * (unit === 'SM' ? 1609.344 / 1852 : 1);
  if (!Number.isFinite(distanceNm) || distanceNm > 999) return;
  return { radial: compass[direction]!, distanceNm, label: `${distance} ${unit} ${direction}` };
}

/** Consume a complete local description before looking for its explicit anchor.
 * NORTH EAST must not become an airport named EAST. */
function referencedValue<T>(text: string, station: string | undefined, read: (text: string) => T | undefined) {
  let value = read(text), ident = value ? station : undefined;
  const reportingStation = !!value;
  if (!value) {
    const suffix = /^(.*?)\s+(?:(?:OF|AT)\s+)?([A-Z0-9]{3,5})$/.exec(text);
    value = suffix ? read(suffix[1]!) : undefined;
    if (value) ident = suffix![2];
    else {
      const prefix = /^([A-Z0-9]{3,5})\s+(.+)$/.exec(text);
      value = prefix ? read(prefix[2]!) : undefined;
      if (value) ident = prefix![1];
    }
  }
  if (!value || !ident || !validIdent(ident)) return;
  return { value, ident, reportingStation };
}

function estimatedOffset(text: string, station: string | undefined): PirepLocation | undefined {
  // Letter-first compact IDs such as W55 are airport references. Number-first
  // compass forms can also be real IDs (10N); the reference index decides those.
  if (/^[A-Z][A-Z0-9]{2,3}$/.test(text)) return;
  const reference = referencedValue(text, station, compassOffset);
  if (!reference) return;
  const { value: offset, ident, reportingStation } = reference;
  return { text, points: [{ ident, radial: offset.radial, distanceNm: offset.distanceNm, bearing: 'true',
    ...(reportingStation ? { airportOnly: true } : {}) }],
    estimated: `Approx. ${offset.label} of ${ident}${reportingStation ? ' (reporting station)' : ''}` };
}

function approachName(text: string): string | undefined {
  const match = /^(?:ON\s+)?(RNAV(?:\s*\((?:GPS|RNP)\))?|ILS(?:\s+OR\s+LOC)?|LOC(?:\/DME)?|GPS|VOR(?:\/DME)?|NDB|FINAL)(?:\s+([XYZ]))?\s*(?:(?:APCH|APPROACH)\s+)?(?:RWY\s*|RUNWAY\s*)?(0?[1-9]|[12]\d|3[0-6])([LRC]?)(?:\s+(?:APCH|APPROACH))?$/.exec(text);
  return match ? `${match[1]!.replace(/\s+/g, ' ')}${match[2] ? ` ${match[2]}` : ''} RWY ${match[3]!.padStart(2, '0')}${match[4]}` : undefined;
}

function estimatedApproach(text: string, station: string | undefined): PirepLocation | undefined {
  if (/^[A-Z0-9]{3,4}$/.test(text)) return;
  const reference = referencedValue(text, station, approachName);
  if (!reference || reference.ident.length > 4) return;
  const { value: approach, ident, reportingStation } = reference;
  return { text, points: [{ ident, airportOnly: true }],
    estimated: `Approx. ${approach} at ${ident}${reportingStation ? ' (reporting station)' : ''}; airport reference, position along approach unknown` };
}

function validIdent(ident: string): boolean {
  return /^(?:[A-Z0-9]{3,4}|[A-Z]{5})$/.test(ident) && /[A-Z]/.test(ident) && !['UNKN', 'UNK'].includes(ident);
}

function radialDistance(text: string) {
  // Keep the radial at three digits. Only distance padding varies: 01, 1,
  // 001 and 0001 all mean 1 NM; a four-digit distance must have a leading zero.
  const match = /^(\d{3})\s*(\d{1,4})$/.exec(text);
  if (!match || Number(match[1]) > 360 || Number(match[2]) > 999) return;
  return { radial: Number(match[1]) % 360, distanceNm: Number(match[2]),
    ...(match[2]!.length === 3 ? {} : { recovered: true as const }) };
}

function referencePoint(text: string): PirepLocationPoint | undefined {
  if (validIdent(text)) return { ident: text };
  const options: PirepLocationReference[] = [];
  // A greedy four-character ID silently misreads MQP2260020 as MQP2/260/020.
  // Keep both splits until published identities can distinguish them. Standard
  // three-digit distance encoding wins when its reference actually exists.
  for (const length of [3, 4, 5]) {
    const ident = text.slice(0, length), offset = radialDistance(text.slice(length).trimStart());
    if (validIdent(ident) && offset) options.push({ ident, ...offset });
  }
  options.sort((a, b) => Number(!!a.recovered) - Number(!!b.recovered));
  const [first, ...alternatives] = options;
  return first && { ...first, ...(alternatives.length ? { alternatives } : {}) };
}

/** FAA JO 7110.10 §8-1-5: TEI-scoped reader; /RM is terminal free text.
 * Recognize whole fields before interpreting a location. Cloud-layer slashes,
 * duplicate /OV fields and text in remarks must never become a position. */
export function readPirepLocation(raw: string): PirepLocationRead {
  const unsupported = { reason: 'Location format not recognized' };
  const field = readPirepField(raw, 'OV');
  if (!field) return unsupported;
  const { value: location, station } = field;
  if (location === undefined) return { reason: 'No /OV location supplied' };
  if (!location || location.length > 512) return unsupported;
  const estimated = estimatedOffset(location, station);
  if (estimated) {
    // A full published identifier wins; only an absent ID permits the compact
    // offset interpretation. Do not decide this from token length alone.
    if (/^\d[A-Z0-9]{2,3}$/.test(location)) return { location: { text: location, points: [{ ident: location }],
      offsetFallback: { points: estimated.points, estimated: estimated.estimated! } } };
    return { location: estimated };
  }
  const approach = estimatedApproach(location, station);
  if (approach) return { location: approach };
  const implicit = radialDistance(location);
  if (implicit && station && validIdent(station)) return { location: { text: location,
    points: [{ ident: station, ...implicit, airportOnly: true }],
    estimated: `Approx. ${implicit.distanceNm} NM on ${implicit.radial.toString().padStart(3, '0')}° magnetic bearing from ${station} (reporting station)` } };
  const segments = location.split(/\s*[-–]\s*/);
  if (segments.length > 16) return unsupported;
  const points: PirepLocationPoint[] = [];
  for (const segment of segments) {
    const coordinate = /^(\d{2})(\d{2})([NS])\s*(\d{3})(\d{2})([EW])$/.exec(segment);
    if (coordinate) {
      const lat = Number(coordinate[1]) + Number(coordinate[2]) / 60;
      const lon = Number(coordinate[4]) + Number(coordinate[5]) / 60;
      if (Number(coordinate[2]) >= 60 || Number(coordinate[5]) >= 60 || lat > 90 || lon > 180) return unsupported;
      points.push({ coordinate: [lon * (coordinate[6] === 'W' ? -1 : 1), lat * (coordinate[3] === 'S' ? -1 : 1)] });
      continue;
    }
    const point = referencePoint(segment);
    if (!point) return unsupported;
    points.push(point);
  }
  return { location: { text: location, points } };
}
