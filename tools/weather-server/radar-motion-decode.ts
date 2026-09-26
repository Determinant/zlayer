import { isRadarMotionSnapshot, RADAR_MOTION_ROOT, type RadarMotionScan, type RadarCellTrack } from '@zlayer/contracts';
import { WeatherSourceError } from './source-error';

const fail = (): never => { throw new WeatherSourceError('Unsupported or invalid NOAA storm tracking data'); };
const epoch = (day: number, seconds: number) => (day - 1) * 86400_000 + seconds * 1000;
const MESSAGE_HEADER_BYTES = 120;
const BLOCK_POINTER = { symbology: 108, tabular: 116 } as const;
type ProjectTrack = (x: number, y: number) => [number, number];

function readBlock(message: Buffer, offset: number, id: number): Buffer {
  const start = message.readUInt32BE(offset) * 2;
  if (start < MESSAGE_HEADER_BYTES || start + 10 > message.length || message.readInt16BE(start) !== -1 || message.readInt16BE(start + 2) !== id) return fail();
  const end = start + message.readUInt32BE(start + 4);
  if (end > message.length || end < start + 10) return fail();
  return message.subarray(start, end);
}

// Tabular block embeds another header, followed by length-prefixed ASCII lines.
function readInterval(tabular: Buffer): number {
  if (tabular.length < 132 || tabular.readInt16BE(8) !== 101 || tabular.readInt16BE(128) !== -1) return fail();
  const pages = tabular.readUInt16BE(130), lines: string[] = [];
  if (!pages || pages > 48) return fail();
  let cursor = 132;
  for (let page = 0; page < pages; page++) {
    for (;;) {
      if (cursor + 2 > tabular.length) return fail();
      const length = tabular.readInt16BE(cursor); cursor += 2;
      if (length === -1) break;
      if (length < 0 || length > 80 || cursor + length > tabular.length || lines.length >= 2400) return fail();
      lines.push(tabular.toString('ascii', cursor, cursor + length)); cursor += length;
    }
  }
  if (cursor !== tabular.length) return fail();
  const interval = Number(/(\d+)\s+\(MIN\) FORECAST INTERVAL/.exec(lines.join('\n'))?.[1]);
  if (interval < 5 || interval > 60 || interval % 5 !== 0) return fail();
  return interval;
}

function trackProjection(latitude: number, longitude: number): ProjectTrack {
  return (x: number, y: number): [number, number] => {
    if (Math.abs(x) > 2048 || Math.abs(y) > 2048) return fail();
    const radians = Math.PI / 180, angle = Math.atan2(x, y), distance = Math.hypot(x, y) * .25 / 6371.0088, lat = latitude * radians;
    const next = Math.asin(Math.sin(lat) * Math.cos(distance) + Math.cos(lat) * Math.sin(distance) * Math.cos(angle));
    return [longitude + Math.atan2(Math.sin(angle) * Math.sin(distance) * Math.cos(lat), Math.cos(distance) - Math.sin(lat) * Math.sin(next)) / radians,
      next / radians].map(n => Math.round(n * 1e5) / 1e5) as [number, number];
  };
}

function readTracks(symbology: Buffer, interval: number, project: ProjectTrack): RadarCellTrack[] {
  const tracks: RadarCellTrack[] = [];
  const layers = symbology.readUInt16BE(8);
  if (!layers || layers > 18) return fail();
  let at = 10;
  for (let layer = 0; layer < layers; layer++) {
    if (at + 6 > symbology.length || symbology.readInt16BE(at) !== -1) return fail();
    const end = at + 6 + symbology.readUInt32BE(at + 2); at += 6;
    if (end > symbology.length) return fail();
    let cell: { id: string; x: number; y: number } | undefined;
    while (at < end) {
      if (at + 4 > end) return fail();
      const code = symbology.readUInt16BE(at), length = symbology.readUInt16BE(at + 2), start = at + 4, stop = start + length;
      if (stop > end || !length || length % 2) return fail();
      if (code === 15) {
        if (length !== 6) return fail();
        cell = { id: symbology.toString('ascii', start + 4, stop), x: symbology.readInt16BE(start), y: symbology.readInt16BE(start + 2) };
      } else if (code === 24) {
        if (!cell) return fail();
        let nested = start, coordinates: [number, number][] | undefined, stationary = false;
        while (nested < stop) {
          if (nested + 4 > stop) return fail();
          const kind = symbology.readUInt16BE(nested), size = symbology.readUInt16BE(nested + 2); nested += 4;
          if (nested + size > stop || !size) return fail();
          if (kind === 6) {
            if (coordinates || size < 8 || size > 20 || size % 4 || symbology.readInt16BE(nested) !== cell.x || symbology.readInt16BE(nested + 2) !== cell.y) return fail();
            coordinates = [];
            for (let p = nested; p < nested + size; p += 4) coordinates.push(project(symbology.readInt16BE(p), symbology.readInt16BE(p + 2)));
          } else if (kind === 25 && size === 6) stationary = true;
          else if (kind !== 2 || size !== 6) return fail();
          nested += size;
        }
        if (!coordinates && !stationary) return fail();
        if (coordinates) tracks.push({ id: cell.id, intervalMinutes: interval, coordinates });
        cell = undefined;
      } else if (code !== 2 && code !== 23 && !(code === 25 && length === 6)) return fail();
      at = stop;
    }
  }
  if (at !== symbology.length) return fail();
  return tracks;
}

/** NEXRAD product 58, ICD 2620001AD: quarter-km Cartesian SCIT positions.
 * Read the supplied forecast polyline, never infer motion from wind or echoes. */
export function decodeStormTracks(raw: Buffer, site: string, sourceHash: string): RadarMotionScan {
  const heading = /^SDUS\d{2} [A-Z]{4} \d{6}\r\r\nNST([A-Z]{3})\r\r\n/.exec(raw.toString('ascii', 0, 80));
  if (!heading || site !== `K${heading[1]}` || raw.length > 512 * 1024) return fail();
  const message = raw.subarray(heading[0].length);
  if (message.length < MESSAGE_HEADER_BYTES || message.readInt16BE(0) !== 58 || message.readUInt32BE(8) !== message.length || message.readInt16BE(18) !== -1 || message.readInt16BE(30) !== 58) return fail();
  const latitude = message.readInt32BE(20) / 1000, longitude = message.readInt32BE(24) / 1000;
  const day = message.readUInt16BE(40), seconds = message.readUInt32BE(42), observedAt = epoch(day, seconds);
  if (!day || seconds >= 86400 || latitude < 20 || latitude > 55 || longitude < -130 || longitude > -60) return fail();
  const interval = readInterval(readBlock(message, BLOCK_POINTER.tabular, 3));
  const project = trackProjection(latitude, longitude);
  const hasCells = message.readUInt32BE(BLOCK_POINTER.symbology) !== 0;
  // No detected cells is valid: NOAA omits the symbology block entirely.
  if (!hasCells && message.readUInt16BE(92) !== 0) return fail();
  const tracks = hasCells ? readTracks(readBlock(message, BLOCK_POINTER.symbology, 1), interval, project) : [];
  const scan = { site, observedAt, source: `${RADAR_MOTION_ROOT}SI.${site.toLowerCase()}/sn.last`, sourceHash, tracks };
  if (!isRadarMotionSnapshot({ schemaVersion: 1, scans: [scan] })) return fail();
  return scan;
}
