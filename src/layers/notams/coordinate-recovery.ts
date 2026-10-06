import type { NotamRecord } from '@zlayer/contracts';
import { distanceNm } from '@zlayer/domain';
import { notamCoordinate, type NotamCoordinate as Point } from './coordinates';
import type { NotamAreaReference, NotamAreaReferences } from './area-references';
import { bearing } from './area-geometry';

export type CoordinateRecovery = { candidates: Point[]; anchor: NotamAreaReference; distance: number; direction: number; hemisphereOnly: boolean };
export type CoordinateToken = { location: Point | CoordinateRecovery; length: number; recovered?: boolean };
const compass = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const boundary = '(?=\\s|[().,;]|TO\\b|$)';
const standard = new RegExp('^(\\d{2})(\\d{2})(\\d{2}(?:\\.\\d+)?)?([NS])\\s*\\/?\\s*(\\d{3})(\\d{2})(\\d{2}(?:\\.\\d+)?)?([EW])' + boundary);

/** Read a complete token; never accept a valid-looking substring of a damaged coordinate. */
export function coordinateToken(text: string): CoordinateToken | undefined {
  const match = standard.exec(text);
  if (match) {
    match[3] ||= '0'; match[7] ||= '0';
    const location = notamCoordinate(match);
    if (location) return { location, length: match[0].length };
    // Exactly 60 seconds is a carry, not a guessed missing digit. Minutes still must be valid.
    if ([match[3], match[7]].some(s => Number(s) === 60) && Number(match[2]) < 60 && Number(match[6]) < 60 &&
        Number(match[3]) <= 60 && Number(match[7]) <= 60) {
      const lat = Number(match[1]) + Number(match[2]) / 60 + Number(match[3]) / 3600;
      const lon = Number(match[5]) + Number(match[6]) / 60 + Number(match[7]) / 3600;
      if (lat <= 90 && lon <= 180) return { location: [lon * (match[8] === 'W' ? -1 : 1), lat * (match[4] === 'S' ? -1 : 1)],
        length: match[0].length, recovered: true };
    }
    return;
  }
  // A two-digit longitude is unambiguous when a three-digit interpretation exceeds 180°.
  const unpadded = new RegExp('^(\\d{4}(?:\\d{2}(?:\\.\\d+)?)?[NS]\\s*\\/?\\s*)(\\d{6}(?:\\.\\d+)?)([EW])' + boundary).exec(text);
  if (unpadded && Number(unpadded[2]!.slice(0, 3)) > 180) {
    const parsed = coordinateToken(unpadded[1]! + '0' + unpadded[2]! + unpadded[3]!);
    return parsed && { ...parsed, length: unpadded[0].length };
  }
  // A transposed longitude hemisphere (07240W00) preserves every numeric field.
  const moved = new RegExp('^(\\d{6}(?:\\.\\d+)?[NS])\\s*(\\d{5})([EW])(\\d{2}(?:\\.\\d+)?)' + boundary).exec(text);
  if (moved) {
    const parsed = coordinateToken(moved[1]! + moved[2]! + moved[4]! + moved[3]!);
    return parsed && { ...parsed, length: moved[0].length, recovered: true };
  }
  // Missing/invalid hemisphere and excess precision need an independent local distance annotation.
  const damaged = new RegExp('^(\\d{4,9}(?:\\.\\d+)?)([NSM])\\s*\\/?\\s*(\\d{5,10}(?:\\.\\d+)?)([EW])?' + boundary).exec(text);
  if (!damaged) return;
  const annotation = /^\s*\((\d+(?:\.\d+)?)\s*NM\s*([NSEW]{1,3})\s+([A-Z0-9]{2,5})\)/.exec(text.slice(damaged[0].length));
  if (!annotation || !compass.includes(annotation[2]!)) return;
  const values = (digits: string, width: number): string[] => {
    if (digits.split('.')[0]!.length === width || digits.length === width - 2) return [digits];
    // A missing decimal separator can be recovered only when the stated distance agrees.
    if (!digits.includes('.') && digits.length > width && digits.length <= width + 2) return [digits.slice(0, width) + '.' + digits.slice(width)];
    return [];
  };
  const candidates: Point[] = [];
  for (const lat of values(damaged[1]!, 6)) for (const lon of values(damaged[3]!, 7)) {
    for (const ns of damaged[2] === 'M' ? ['N', 'S'] : [damaged[2]!]) for (const ew of damaged[4] ? [damaged[4]] : ['E', 'W']) {
      const parsed = standard.exec(lat + ns + lon + ew);
      if (!parsed) continue;
      parsed[3] ||= '0'; parsed[7] ||= '0';
      const point = notamCoordinate(parsed); if (point) candidates.push(point);
    }
  }
  if (!candidates.length) return;
  return { location: { candidates, anchor: { ident: annotation[3]!, kind: 'airport' },
    hemisphereOnly: values(damaged[1]!, 6)[0] === damaged[1] && values(damaged[3]!, 7)[0] === damaged[3],
    distance: Number(annotation[1]), direction: compass.indexOf(annotation[2]!) * 22.5 }, length: damaged[0].length, recovered: true };
}

export function resolveCoordinate(location: CoordinateRecovery, record: NotamRecord, references?: NotamAreaReferences): Point | undefined {
  const anchor = references?.(location.anchor, record); if (!anchor) return;
  const matches = location.candidates.filter(point => {
    // Plain-language distances can be rounded and directions can use 8- or 16-point compass labels.
    const delta = Math.abs(((bearing(anchor, point) - location.direction + 540) % 360) - 180);
    return Math.abs(distanceNm(anchor, point) - location.distance) <= (location.hemisphereOnly ? Math.max(2, location.distance * .05) : Math.max(.25, location.distance * .02)) && delta <= 25;
  });
  return matches.length === 1 ? matches[0] : undefined;
}
