import type { NotamRecord } from '@zlayer/contracts';
import { parseNotam } from './parser';
import type { NotamAreaReferences } from './area-references';
import { notamScopes } from './clauses';
import { notamParts, maskNotamParts } from './multipart';

type Radial = { ident: string; radial: number };
const cache = new WeakMap<NotamRecord, readonly Radial[]>();

/** Explicit unusable/restricted VOR radials, distinct from R-xxxx restricted areas
 * and healthy route references. These supply direction context, never an extent. */
export function notamRadials(record: NotamRecord): readonly Radial[] {
  const previous = cache.get(record); if (previous) return previous;
  const body = parseNotam(record).body;
  const parts = notamParts(body), scopes = parts && notamScopes(maskNotamParts(body, parts));
  const result = new Map<string, Radial>();
  // A qualified route still needs a station-direction cue. Keep all qualifications
  // in the reader; instructions and unassembled parts never supply live radials.
  for (const scope of scopes ?? []) {
    if (scope.state !== 'operative' && scope.state !== 'conditional') continue;
    for (const match of scope.source.toUpperCase().matchAll(
      /\b([A-Z0-9]{2,5})\s+(?:VOR\/DME|VORTAC|VOR|VTAC|VDME)\s+(R-\d{3}(?:\s*(?:,|AND)\s*R-\d{3})*)\s+(?:DME\s+)?(?:UNUSABLE|UNUSUABLE|UNUSEABLE|RESTRICTED|U\/S)\b/g,
    )) {
      const bearings = [...match[2]!.matchAll(/R-(\d{3})/g)].map(number => Number(number[1]));
      if (bearings.some(bearing => bearing > 360)) continue;
      for (const bearing of bearings) {
        const radial = bearing % 360;
        result.set(`${match[1]}:${radial}`, { ident: match[1]!, radial });
      }
    }
  }
  const radials = [...result.values()]; cache.set(record, radials); return radials;
}

export function notamRadialDirections(record: NotamRecord, references?: NotamAreaReferences) {
  return notamRadials(record).flatMap(radial => {
    // Resolve the same unique station and published alignment used by radial/DME
    // area positions. The second point measures direction; it is never rendered.
    const origin = references?.({ ...radial, distanceNm: 0 }, record);
    const next = references?.({ ...radial, distanceNm: 1 }, record);
    if (!origin || !next) return [];
    const radians = Math.PI / 180, a = origin[1] * radians, b = next[1] * radians;
    const d = (next[0] - origin[0]) * radians;
    const bearing = (Math.atan2(Math.sin(d) * Math.cos(b),
      Math.cos(a) * Math.sin(b) - Math.sin(a) * Math.cos(b) * Math.cos(d)) / radians + 360) % 360;
    return [{ ...radial, coordinates: origin, bearing }];
  });
}
