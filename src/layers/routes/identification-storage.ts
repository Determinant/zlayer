import { isRecord } from '@zlayer/contracts';
import { isRadialCoordinate, parseRadialDefinition, radialDefinitionMatches, readRadialPosition, type RadialPosition,
  type RouteEntry, type RoutePointForm, type RoutePointIdentification } from '@zlayer/domain';

/** Reject invalid position snapshots instead of silently recomputing a saved point. */
export function identificationFields(entry: Record<string, unknown>): Pick<RouteEntry, 'radialPosition' | 'identifications'> | undefined {
  const fields: { radialPosition?: RadialPosition; identifications?: RoutePointIdentification[] } = {};
  if (entry.radialPosition !== undefined) {
    const parsed = readRadialPosition(entry.radialPosition), definition = typeof entry.text === 'string' ? parseRadialDefinition(entry.text) : undefined;
    if (!parsed || !definition || !radialDefinitionMatches(definition, parsed) || entry.pinnedFeatureId !== undefined) return;
    fields.radialPosition = parsed;
  }
  if (entry.identifications !== undefined) {
    if (!Array.isArray(entry.identifications)) return;
    const keys = new Set<string>();
    fields.identifications = [];
    for (const value of entry.identifications) {
      if (!isRecord(value) || typeof value.key !== 'string' || keys.has(value.key) || !isRecord(value.form)) return;
      let key: unknown;
      try { key = JSON.parse(value.key); } catch { return; }
      if (!Array.isArray(key) || (key.length !== 3 && key.length !== 4) || typeof key[0] !== 'string' ||
          !isRadialCoordinate(key[1]) || typeof key[2] !== 'string' ||
          key.length === 4 && (!Number.isSafeInteger(key[3]) || key[3] <= 0)) return;
      let form: RoutePointForm;
      if (value.form.kind === 'coordinate') form = { kind: 'coordinate' };
      else {
        const parsed = value.form.kind === 'radial' ? readRadialPosition({ ...value.form, coordinate: key[1] }) : undefined;
        if (!parsed) return;
        form = { kind: 'radial', reference: parsed.reference, radial: parsed.radial, distanceNm: parsed.distanceNm };
      }
      keys.add(value.key);
      fields.identifications.push({ key: value.key, form });
    }
  }
  return fields;
}
