export const NOTAM_COORDINATE = /\b(\d{2})(\d{2})(\d{2}(?:\.\d+)?)([NS])\s*\/?\s*(\d{3})(\d{2})(\d{2}(?:\.\d+)?)([EW])\b/g;
export type NotamCoordinate = [number, number];

function degrees(degree: string, minute: string, second: string, hemisphere: string, limit: number): number | undefined {
  const d = Number(degree), m = Number(minute), s = Number(second);
  if (d > limit || m >= 60 || s >= 60 || d === limit && (m !== 0 || s !== 0)) return undefined;
  return (d + m / 60 + s / 3600) * ('SW'.includes(hemisphere) ? -1 : 1);
}

/** Invalid DMS stays invalid; never normalize 60 seconds or a coordinate beyond a pole. */
export function notamCoordinate(match: RegExpMatchArray): NotamCoordinate | undefined {
  const lat = degrees(match[1]!, match[2]!, match[3]!, match[4]!, 90);
  const lon = degrees(match[5]!, match[6]!, match[7]!, match[8]!, 180);
  return lat === undefined || lon === undefined ? undefined : [lon, lat];
}
