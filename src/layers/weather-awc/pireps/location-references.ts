import type { GeoPointFeature, NavigationData } from '@zlayer/contracts';
import { distanceNm, featureIdent, featureIdentifiers, isAirportFeature, isRadialCoordinate,
  isVorReference, positionOnRadial, radialReference, referenceForDefinition } from '@zlayer/domain';
import { magneticField, type MagneticModel } from '../../../core/geo/magnetic-model';
import type { PirepLocation, PirepLocationReference } from './location';
import stations from './station-references.json';

type Point = [number, number];
type SourceLocationHint = { station: string; coordinate: Point };
export type PirepLocationResult = { coordinate: Point; description: string; estimated?: boolean } | { reason: string };

/** Resolve published identities before inferring compass offsets. Local approach
 * descriptions use an explicitly labeled airport reference, not an invented point
 * along an approach or a nearby airport guess. */
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
    if (location.offsetFallback) {
      if (!data?.airports || !data.navaids) return { reason: `${location.text}: reference data unavailable` };
      if (!index.has(location.text)) location = { text: location.text, ...location.offsetFallback };
    }
    const points: Point[] = [];
    const stationReferences = new Set<string>(), recovered = new Set<string>();
    for (let point of location.points) {
      if ('coordinate' in point) { points.push(point.coordinate); continue; }
      // The two files arrive independently. Do not briefly resolve an airport
      // alias before its same-ID VOR (or an exact K-prefixed airport) arrives.
      if (!data?.airports || !point.airportOnly && !data.navaids) return { reason: `${point.ident}: reference data unavailable` };
      if (point.ident.length === 5 && !data.fixes) return { reason: `${point.ident}: fix data unavailable` };
      if (point.alternatives) {
        const known = [point, ...point.alternatives].filter(option => candidatesFor(option).length);
        const standard = known.filter(option => !option.recovered), choices = standard.length ? standard : known;
        if (choices.length !== 1) return { reason: `${location.text}: ${choices.length ? 'ambiguous reference encoding' : 'reference unavailable'}` };
        point = choices[0]!;
      }
      const matches = candidatesFor(point);
      // A single-letter typo may use the reporting station only when the source
      // position agrees with that published identity within coordinate rounding. Keep it
      // approximate; a bad_location coordinate alone never supplies the marker.
      if (!matches.length && !excludedIdentities.has(point.ident) && data.fixes && hint &&
        ![data.airports, data.navaids, data.fixes].some(collection => collection?.meta.truncated) &&
        location.points.length === 1 && !location.offsetFallback &&
        !point.airportOnly && point.radial === undefined && /^[A-Z]{3}$/.test(point.ident) &&
        /^[A-Z]{3}$/.test(hint.station) && [...point.ident].filter((letter, i) => letter !== hint.station[i]).length === 1) {
        const station = candidatesFor({ ident: hint.station });
        if (station.length === 1 && distanceNm(station[0]!.geometry.coordinates, hint.coordinate) <= .01) {
          return { coordinate: [...station[0]!.geometry.coordinates], estimated: true,
            description: `Approx. /OV ${point.ident} → ${hint.station}; reporting station and source position agree` };
        }
      }
      if (matches.length !== 1) return { reason: `${point.ident}: ${matches.length ? 'ambiguous reference' : 'reference unavailable'}` };
      const feature = matches[0]!;
      if (feature.properties.kind === 'weather-station') stationReferences.add(point.ident);
      if (point.recovered && !location.estimated) recovered.add(`${point.ident} ${point.radial!.toString().padStart(3, '0')}° / ${point.distanceNm} NM`);
      if (point.radial === undefined || point.distanceNm === 0) { points.push([...feature.geometry.coordinates]); continue; }
      const reference = !point.bearing && isVorReference(feature) ? radialReference(feature) : referenceForDefinition(feature,
        { station: featureIdent(feature), radial: point.radial, distanceNm: point.distanceNm!, bearing: point.bearing ?? 'magnetic' },
        coordinate => {
          const field = model && magneticField(model, coordinate, 0, observedAt);
          return field && field.horizontal >= 6000 ? {
            declination: field.declination, model: model!.model, epoch: model!.epoch, time: observedAt,
          } : undefined;
        });
      if (!reference) return { reason: `${point.ident}: ${isVorReference(feature) ? 'station alignment' : 'magnetic model'} unavailable` };
      points.push(positionOnRadial(reference, point.radial, point.distanceNm!).coordinate);
    }
    const coordinate = points.length === 1 ? points[0] : routeMidpoint(points);
    const description = location.estimated ?? `${points.length > 1 ? 'Route midpoint' : 'Decoded /OV'} · ${location.text}`;
    return coordinate ? { coordinate, description: [description, ...recovered,
      ...(stationReferences.size ? [`AWC station reference: ${[...stationReferences].join(', ')}`] : [])].join(' · '),
      ...(location.estimated || stationReferences.size ? { estimated: true } : {}) }
      : { reason: 'Route location is ambiguous' };
  };
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
