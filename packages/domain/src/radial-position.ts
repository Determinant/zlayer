import { isRecord, type GeoPointFeature, type PointGeometry } from '@zlayer/contracts';
import { featureIdent, featureIdentifiers, featureKey } from './features.js';
import { normalizeNavaidType } from './navaids.js';

export type RadialDefinition = { station: string; radial: number; distanceNm: number; bearing?: 'radial' | 'magnetic' | 'true' };
export type MagneticReference = { declination: number; model: string; epoch: number; time: number };
export type MagneticReferenceResolver = (coordinate: PointGeometry['coordinates']) => MagneticReference | undefined;
export type RadialReference = {
  id: string; ident: string; coordinate: PointGeometry['coordinates']; declination: number;
  revision: string; sourceKey: string;
  /** Absent means a published VOR radial, preserving existing saved snapshots. */
  bearing?: 'magnetic' | 'true';
  magnetic?: Omit<MagneticReference, 'declination'>;
};

export const isVorReference = (feature: GeoPointFeature): boolean =>
  ['VOR', 'VOR/DME', 'VORTAC'].includes(normalizeNavaidType(feature.properties.type));

/** The nearby recommendation radius and MON ranking never restrict typed references. */
export function radialReferenceCandidates(definition: RadialDefinition, features: readonly GeoPointFeature[]): GeoPointFeature[] {
  const matches = features.filter(feature => feature.properties.kind !== 'coordinate' && featureIdentifiers(feature).includes(definition.station));
  const vors = matches.filter(isVorReference);
  if (definition.bearing === 'radial' || !definition.bearing && vors.length) return vors;
  const primary = matches.filter(feature => featureIdent(feature) === definition.station);
  // A missing VOR export must not turn its short ID into an airport-alias bearing.
  return primary.length ? primary : definition.bearing ? matches : [];
}

export function referenceForDefinition(feature: GeoPointFeature, definition: RadialDefinition,
  magnetic?: MagneticReferenceResolver): RadialReference | undefined {
  if (!featureIdentifiers(feature).includes(definition.station)) return;
  if (definition.bearing === 'radial' || !definition.bearing && isVorReference(feature)) return radialReference(feature);
  const bearing = definition.bearing === 'true' ? 'true' : 'magnetic';
  const alignment = bearing === 'magnetic' ? magnetic?.(feature.geometry.coordinates) : undefined;
  if (bearing === 'magnetic' && !alignment) return;
  return { id: featureKey(feature), ident: definition.station, coordinate: [...feature.geometry.coordinates],
    declination: alignment?.declination ?? 0, revision: String(feature.properties.dataRevision ?? ''),
    sourceKey: String(feature.properties.dataSourceKey ?? ''), bearing,
    ...(alignment ? { magnetic: { model: alignment.model, epoch: alignment.epoch, time: alignment.time } } : {}) };
}
export type RadialPosition = {
  coordinate: PointGeometry['coordinates']; reference: RadialReference; radial: number; distanceNm: number;
};

/** A station radial is outbound and uses published station alignment, not WMM. */
export function radialReference(feature: GeoPointFeature): RadialReference | undefined {
  const declination = feature.properties.stationDeclinationDeg;
  const status = feature.properties.status;
  const ident = featureIdent(feature);
  if (!isVorReference(feature) ||
      !/^[A-Z0-9]{2,5}$/.test(ident) || typeof declination !== 'number' ||
      !Number.isFinite(declination) || Math.abs(declination) > 180 ||
      typeof status === 'string' && status.trim() && !/^OPERATIONAL(?:\s|$)/i.test(status.trim())) return;
  return { id: featureKey(feature), ident, coordinate: [...feature.geometry.coordinates], declination,
    revision: String(feature.properties.dataRevision ?? ''), sourceKey: String(feature.properties.dataSourceKey ?? '') };
}

export function parseRadialDefinition(text: string): RadialDefinition | undefined {
  const slash = /^([A-Z0-9]{2,8})\/(\d{3}(?:\.\d+)?)([RMT]?)\/(\d+(?:\.\d+)?)$/.exec(text);
  const match = slash ?? /^([A-Z0-9]{2,5}?)(\d{3})(\d{3})$/.exec(text);
  if (!match) return;
  const radial = Number(match[2]), distanceNm = Number(match[slash ? 4 : 3]);
  if (radial > 360 || !Number.isFinite(distanceNm) || distanceNm <= 0 || distanceNm >= Math.PI * 3440.065) return;
  return { station: match[1]!, radial: radial % 360, distanceNm,
    ...(slash?.[3] ? { bearing: slash[3] === 'R' ? 'radial' as const : slash[3] === 'M' ? 'magnetic' as const : 'true' as const } : {}) };
}

export function radialDefinitionText(value: RadialDefinition): string {
  const bearing = decimalText(value.radial || 360).split('.');
  const suffix = value.bearing === 'true' ? 'T' : value.bearing === 'magnetic' ? 'M' : value.bearing === 'radial' ? 'R' : '';
  return `${value.station}/${bearing[0]!.padStart(3, '0')}${bearing[1] ? `.${bearing[1]}` : ''}${suffix}/${decimalText(value.distanceNm)}`;
}

/** Accepted small decimals must not normalize into unparseable exponent notation. */
function decimalText(value: number): string {
  return String(value).replace(/^(\d)(?:\.(\d+))?e-(\d+)$/, (_match, first: string, rest: string | undefined, exponent: string) =>
    `0.${'0'.repeat(Number(exponent) - 1)}${first}${rest ?? ''}`);
}

/** Spherical direct solution; uses the same earth radius as route ground distance. */
export function positionOnRadial(reference: RadialReference, radial: number, distanceNm: number): RadialPosition {
  const radians = Math.PI / 180, angle = distanceNm / 3440.065;
  const bearing = (radial + reference.declination) * radians;
  const latitude = reference.coordinate[1] * radians, longitude = reference.coordinate[0] * radians;
  const lat = Math.asin(Math.max(-1, Math.min(1,
    Math.sin(latitude) * Math.cos(angle) + Math.cos(latitude) * Math.sin(angle) * Math.cos(bearing))));
  const lon = longitude + Math.atan2(Math.sin(bearing) * Math.sin(angle) * Math.cos(latitude),
    Math.cos(angle) - Math.sin(latitude) * Math.sin(lat));
  return { coordinate: [((lon / radians + 180) % 360 + 360) % 360 - 180, lat / radians], reference, radial, distanceNm };
}

export function radialPositionFeature(position: RadialPosition): GeoPointFeature {
  const ident = radialDefinitionText({ station: position.reference.ident, radial: position.radial, distanceNm: position.distanceNm,
    ...(position.reference.bearing ? { bearing: position.reference.bearing } : {}) });
  return { type: 'Feature', id: `radial:${JSON.stringify([position.reference.id, position.coordinate])}`,
    geometry: { type: 'Point', coordinates: position.coordinate },
    properties: { kind: 'coordinate', ident, name: position.reference.bearing ? 'Bearing / ground distance' : 'Radial / ground distance', radialPosition: position } };
}

export const isRadialCoordinate = (value: unknown): value is [number, number] => Array.isArray(value) && value.length === 2 &&
  value.every(part => typeof part === 'number' && Number.isFinite(part)) && Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90;

/** Validate snapshots from storage and rendered GeoJSON (which can stringify objects). */
export function readRadialPosition(input: unknown): RadialPosition | undefined {
  let value = input;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return; } }
  if (!isRecord(value) || !isRadialCoordinate(value.coordinate) || !isRecord(value.reference)) return;
  const ref = value.reference;
  if (typeof ref.id !== 'string' || !ref.id || typeof ref.ident !== 'string' || !/^[A-Z0-9]{2,8}$/.test(ref.ident) ||
      !isRadialCoordinate(ref.coordinate) || typeof ref.declination !== 'number' || !Number.isFinite(ref.declination) ||
      Math.abs(ref.declination) > 180 || typeof ref.revision !== 'string' || typeof ref.sourceKey !== 'string' ||
      typeof value.radial !== 'number' || !Number.isFinite(value.radial) || value.radial < 0 || value.radial >= 360 ||
      typeof value.distanceNm !== 'number' || !Number.isFinite(value.distanceNm) || value.distanceNm <= 0 || value.distanceNm >= Math.PI * 3440.065) return;
  if (ref.bearing !== undefined && ref.bearing !== 'magnetic' && ref.bearing !== 'true') return;
  if (ref.bearing === 'true' && (ref.declination !== 0 || ref.magnetic !== undefined)) return;
  if (ref.bearing === 'magnetic' && (!isRecord(ref.magnetic) || typeof ref.magnetic.model !== 'string' || !ref.magnetic.model ||
      typeof ref.magnetic.epoch !== 'number' || !Number.isFinite(ref.magnetic.epoch) ||
      typeof ref.magnetic.time !== 'number' || !Number.isFinite(ref.magnetic.time))) return;
  if (ref.bearing === undefined && ref.magnetic !== undefined) return;
  const reference: RadialReference = { id: ref.id, ident: ref.ident, coordinate: [...ref.coordinate], declination: ref.declination,
    revision: ref.revision, sourceKey: ref.sourceKey,
    ...(ref.bearing ? { bearing: ref.bearing } : {}),
    ...(isRecord(ref.magnetic) ? { magnetic: { model: ref.magnetic.model as string, epoch: ref.magnetic.epoch as number, time: ref.magnetic.time as number } } : {}) };
  const calculated = positionOnRadial(reference, value.radial, value.distanceNm).coordinate;
  if (Math.abs(calculated[1] - value.coordinate[1]) > 1e-7 ||
      Math.abs(((calculated[0] - value.coordinate[0] + 540) % 360) - 180) > 1e-7) return;
  return { coordinate: [...value.coordinate], reference, radial: value.radial, distanceNm: value.distanceNm };
}

export function radialPositionFromFeature(feature: GeoPointFeature): RadialPosition | undefined {
  if (feature.properties.kind !== 'coordinate') return;
  const definition = parseRadialDefinition(feature.properties.ident ?? '');
  const position = readRadialPosition(feature.properties.radialPosition);
  return definition && position && radialDefinitionMatches(definition, position) ? position : undefined;
}

export function radialDefinitionMatches(definition: RadialDefinition, position: RadialPosition): boolean {
  const bearing = position.reference.bearing;
  return definition.station === position.reference.ident && definition.radial === position.radial && definition.distanceNm === position.distanceNm &&
    (definition.bearing ? (definition.bearing === 'radial' ? bearing === undefined : bearing === definition.bearing) : bearing !== 'true');
}
