import type { GeoPointFeature, NavigationData } from '@zlayer/contracts';
import { distanceNm, featureIdent, featureIdentifiers, isAirportFeature, isRadialCoordinate,
  isVorReference, positionOnRadial, radialReference, referenceForDefinition } from '@zlayer/domain';
import { magneticField, type MagneticModel } from '../../../core/geo/magnetic-model';
import type { PirepLocation, PirepLocationRecovery, PirepLocationReference } from './location';
import { referenceRank } from './location';
import stations from './station-references.json';

type Point = [number, number];
type SourceLocationHint = { station: string; coordinate: Point };
export type PirepLocationResult = { coordinate: Point; description: string; estimated?: boolean; referenceOnly?: boolean } | { reason: string };

/** Resolve published identities before inferring offsets. Local runway and
 * distance-only descriptions use an explicitly labeled airport reference without
 * inventing a flight-path position or a missing direction. */
export function createPirepLocationReferences(data?: NavigationData, model?: MagneticModel) {
  const index = new Map<string, GeoPointFeature[]>();
  const excludedIdentities = new Set<string>();
  for (const feature of [...data?.airports?.features ?? [], ...data?.navaids?.features ?? [], ...data?.fixes?.features ?? []]) {
    const identifiers = featureIdentifiers(feature);
    if (!isRadialCoordinate(feature.geometry.coordinates) ||
      !isAirportFeature(feature) && !isVorReference(feature) &&
      !(feature.properties.kind === 'fix' && /^[A-Z]{5}$/.test(featureIdent(feature)))) {
      for (const ident of identifiers) excludedIdentities.add(ident);
      continue;
    }
    for (const ident of identifiers) index.set(ident, [...index.get(ident) ?? [], feature]);
  }
  const candidatesFor = (point: PirepLocationReference): GeoPointFeature[] => {
    let candidates = index.get(point.ident) ?? [];
    // JO 7110.10 also encodes US VHF stations as K + the three-letter ID.
    if (!candidates.length && /^K[A-Z]{3}$/.test(point.ident)) candidates = (index.get(point.ident.slice(1)) ?? []).filter(isVorReference);
    // Exact international ICAO station references supplement US NASR coverage.
    // No inferred aliases, station-prefix substitutions or reporting-airport guesses.
    if (!candidates.length && !point.airportOnly && Object.hasOwn(stations, point.ident)) {
      const coordinate = stations[point.ident as keyof typeof stations];
      candidates = [{ type: 'Feature', id: `awc-station:${point.ident}`,
        geometry: { type: 'Point', coordinates: [coordinate[0]!, coordinate[1]!] },
        properties: { kind: 'weather-station', ident: point.ident } }];
    }
    const vors = candidates.filter(isVorReference);
    const primary = candidates.filter(f => featureIdent(f) === point.ident);
    return point.airportOnly ? candidates.filter(isAirportFeature)
      : vors.length ? vors : primary.length ? primary : candidates;
  };
  return (location: PirepLocation, observedAt: number, hint?: SourceLocationHint): PirepLocationResult => {
    const identifierChoice = location.kind === 'identifier-or-recovery';
    if (location.kind === 'identifier-or-recovery') {
      if (!data?.airports || !data.navaids) return { reason: `${location.text}: reference data unavailable` };
      if (!index.has(location.ident) && !excludedIdentities.has(location.ident)) {
        if (data.airports.meta.truncated || data.navaids.meta.truncated) return { reason: `${location.text}: reference data incomplete` };
        if (location.fallback.kind === 'rejected') return { reason: location.fallback.reason };
        location = location.fallback;
      } else location = { kind: 'points', text: location.text, points: [{ kind: 'reference', ident: location.ident }] };
    }
    if (location.kind === 'recovery-options') {
      if (!data?.airports || !data.navaids) return { reason: `${location.text}: reference data unavailable` };
      const needsFixes = location.options.some(option => option.anchor.ident.length === 5);
      if (needsFixes && !data.fixes) return { reason: `${location.text}: fix data unavailable` };
      if ([data.airports, data.navaids, ...(needsFixes ? [data.fixes] : [])].some(collection => collection?.meta.truncated)) {
        return { reason: `${location.text}: reference data incomplete` };
      }
      const known = location.options.filter(option => excludedIdentities.has(option.anchor.ident) || candidatesFor(recoveryReference(option)).length);
      if (known.length !== 1) return { reason: `${location.text}: ${known.length ? 'ambiguous reference encoding' : 'reference unavailable'}` };
      location = known[0]!;
    }
    const recovery = location.kind === 'recovery' ? location : undefined;
    const definitions = location.kind === 'points' ? location.points : [recoveryReference(location)];
    const points: Point[] = [];
    const stationReferences = new Set<string>(), recovered = new Set<string>();
    let referenceOnly = false;
    for (let point of definitions) {
      if (point.kind === 'coordinate') { points.push(point.coordinate); continue; }
      if (point.kind === 'alternatives') {
        if (!data?.airports || !data.navaids) return { reason: `${location.text}: reference data unavailable` };
        if (point.options.some(option => option.ident.length === 5) && !data.fixes) return { reason: `${location.text}: fix data unavailable` };
        const known = point.options.filter(option => excludedIdentities.has(option.ident) || candidatesFor(option).length);
        const bestRank = Math.min(...known.map(referenceRank));
        const choices = known.filter(option => referenceRank(option) === bestRank);
        if (choices.length !== 1) return { reason: `${location.text}: ${choices.length ? 'ambiguous reference encoding' : 'reference unavailable'}` };
        if (bestRank > 0 && [data.airports, data.navaids, data.fixes].some(collection => collection?.meta.truncated)) {
          return { reason: `${location.text}: reference data incomplete` };
        }
        point = choices[0]!;
      }
      // The two files arrive independently. Do not briefly resolve an airport
      // alias before its same-ID VOR (or an exact K-prefixed airport) arrives.
      if (!data?.airports || !point.airportOnly && !data.navaids) return { reason: `${point.ident}: reference data unavailable` };
      if (point.ident.length === 5 && !data.fixes) return { reason: `${point.ident}: fix data unavailable` };
      const matches = candidatesFor(point);
      // A single-letter typo may use the reporting station only when the source
      // position agrees with that published identity within coordinate rounding. Keep it
      // approximate; a bad_location coordinate alone never supplies the marker.
      if (!matches.length && !excludedIdentities.has(point.ident) && data.fixes && hint &&
        ![data.airports, data.navaids, data.fixes].some(collection => collection?.meta.truncated) &&
        definitions.length === 1 && !identifierChoice && !recovery &&
        !point.airportOnly && point.kind === 'reference' && /^[A-Z]{3}$/.test(point.ident) &&
        /^[A-Z]{3}$/.test(hint.station) && [...point.ident].filter((letter, i) => letter !== hint.station[i]).length === 1) {
        const station = candidatesFor({ kind: 'reference', ident: hint.station });
        if (station.length === 1 && distanceNm(station[0]!.geometry.coordinates, hint.coordinate) <= .01) {
          return { coordinate: [...station[0]!.geometry.coordinates], estimated: true,
            description: `Approx. /OV ${point.ident} → ${hint.station}; reporting station and source position agree` };
        }
      }
      if (matches.length !== 1) return { reason: `${point.ident}: ${matches.length ? 'ambiguous reference' : 'reference unavailable'}` };
      const feature = matches[0]!;
      if (feature.properties.kind === 'weather-station') stationReferences.add(point.ident);
      if (point.kind === 'reference-only') {
        referenceOnly = true;
        points.push([...feature.geometry.coordinates]);
        recovered.add(`${point.ident}: reported radial ${point.radial.toString().padStart(3, '0')}°${point.radial > 360 ? ' (invalid)' : ''}; ` +
          (point.distanceNm === undefined ? 'distance unknown' : `reported distance ${point.distanceNm} NM${point.distanceNm > 999 ? ' (invalid)' : ''}`));
        continue;
      }
      if (point.kind === 'offset' && point.recovered && !recovery) recovered.add(`${point.ident} ${point.radial.toString().padStart(3, '0')}° / ${point.distanceNm} NM`);
      if (point.kind === 'reference' || point.distanceNm === 0) { points.push([...feature.geometry.coordinates]); continue; }
      const reference = point.bearing === 'magnetic' && isVorReference(feature) ? radialReference(feature) : referenceForDefinition(feature,
        { station: featureIdent(feature), radial: point.radial, distanceNm: point.distanceNm, bearing: point.bearing },
        coordinate => {
          const field = model && magneticField(model, coordinate, 0, observedAt);
          return field && field.horizontal >= 6000 ? {
            declination: field.declination, model: model!.model, epoch: model!.epoch, time: observedAt,
          } : undefined;
        });
      if (!reference) return { reason: `${point.ident}: ${isVorReference(feature) ? 'station alignment' : 'magnetic model'} unavailable` };
      points.push(positionOnRadial(reference, point.radial, point.distanceNm).coordinate);
    }
    const coordinate = points.length === 1 ? points[0] : routeMidpoint(points);
    const description = recovery ? recoveryDescription(recovery)
      : `${referenceOnly ? 'Reference location only; observation position unknown' : points.length > 1 ? 'Route midpoint' : recovered.size ? 'Approx. decoded /OV (assumed padding)' : 'Decoded /OV'} · ${location.text}`;
    return coordinate ? { coordinate, description: [description, ...recovered,
      ...(stationReferences.size ? [`AWC station reference: ${[...stationReferences].join(', ')}`] : [])].join(' · '),
      ...(recovery || stationReferences.size || referenceOnly || recovered.size ? { estimated: true } : {}), ...(referenceOnly ? { referenceOnly: true } : {}) }
      : { reason: 'Route location is ambiguous' };
  };
}

function recoveryReference({ anchor, description }: PirepLocationRecovery): PirepLocationReference {
  const reference = { ident: anchor.ident,
    ...(anchor.source === 'reporting-station' || description.kind !== 'compass' ? { airportOnly: true as const } : {}) };
  switch (description.kind) {
    case 'compass': return { ...reference, kind: 'offset', bearing: 'true', radial: description.radial, distanceNm: description.distance.distanceNm };
    case 'radial': return { ...reference, kind: 'offset', bearing: 'magnetic', radial: description.radial, distanceNm: description.distanceNm };
    case 'distance': case 'approach': case 'departure': return { ...reference, kind: 'reference' };
  }
}

/** Presentation follows resolved semantics; labels never determine recovery policy. */
function recoveryDescription({ anchor, description }: PirepLocationRecovery): string {
  const reference = `${anchor.ident}${anchor.source === 'reporting-station' ? ' (reporting station)' : ''}`;
  const units = 'distance' in description && description.distance?.assumedUnit ? '; miles interpreted as NM' : '';
  switch (description.kind) {
    case 'compass': return `Approx. ${description.distance.value} ${description.distance.unit} ${description.direction} of ${reference}${units}`;
    case 'distance': return `Approx. ${description.distance.value} ${description.distance.unit} from ${reference}; airport reference, direction unknown${units}`;
    case 'approach': return `Approx. ${description.distance ? `${description.distance.value} ${description.distance.unit} ` : ''}${description.name} at ${reference}; airport reference, position along approach unknown${units}`;
    case 'departure': return `Approx. DEP RWY ${description.runway} at ${reference}; airport reference, position along departure unknown`;
    case 'radial': return `Approx. ${description.distanceNm} NM on ${description.radial.toString().padStart(3, '0')}° magnetic bearing from ${reference}`;
  }
}

/** Representative point halfway along the reported route, not an asserted
 * exact observation point. Reject antipodal legs with no unique great circle. */
function routeMidpoint(points: Point[]): Point | undefined {
  const lengths = points.slice(1).map((point, i) => distanceNm(points[i]!, point));
  if (lengths.some(length => !Number.isFinite(length) || length >= Math.PI * 3440.065 - .01)) return;
  let remaining = lengths.reduce((sum, length) => sum + length, 0) / 2;
  for (const [i, length] of lengths.entries()) {
    if (remaining > length) { remaining -= length; continue; }
    if (length === 0) return points[i];
    const radians = Math.PI / 180, angle = length / 3440.065, fraction = remaining / length;
    const vector = ([lon, lat]: Point) => [Math.cos(lat * radians) * Math.cos(lon * radians),
      Math.cos(lat * radians) * Math.sin(lon * radians), Math.sin(lat * radians)];
    const a = vector(points[i]!), b = vector(points[i + 1]!);
    const p = a.map((value, j) => (value * Math.sin((1 - fraction) * angle) + b[j]! * Math.sin(fraction * angle)) / Math.sin(angle));
    return [Math.atan2(p[1]!, p[0]!) / radians, Math.atan2(p[2]!, Math.hypot(p[0]!, p[1]!)) / radians];
  }
  return points[0];
}
