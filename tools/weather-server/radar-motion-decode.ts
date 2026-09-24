import { isRadarMotionSnapshot, RADAR_MOTION_ROOT, type RadarMotionScan, type RadarCellTrack } from '@zlayer/contracts';

const fail = (): never => { throw new Error('Unsupported or invalid NOAA storm tracking data'); };
const epoch = (day: number, seconds: number) => (day - 1) * 86400_000 + seconds * 1000;
/** NEXRAD product 58, ICD 2620001AD: quarter-km Cartesian SCIT positions.
 * Read the supplied forecast polyline, never infer motion from wind or echoes. */
export function decodeStormTracks(raw: Buffer, site: string, sourceHash: string): RadarMotionScan {
  const heading = /^SDUS\d{2} [A-Z]{4} \d{6}\r\r\nNST([A-Z]{3})\r\r\n/.exec(raw.toString('ascii', 0, 80));
  if (!heading || site !== `K${heading[1]}` || raw.length > 512 * 1024) return fail();
  const b = raw.subarray(heading[0].length);
  if (b.length < 120 || b.readInt16BE(0) !== 58 || b.readUInt32BE(8) !== b.length || b.readInt16BE(18) !== -1 || b.readInt16BE(30) !== 58) return fail();
  const latitude = b.readInt32BE(20) / 1000, longitude = b.readInt32BE(24) / 1000;
  const day = b.readUInt16BE(40), seconds = b.readUInt32BE(42), observedAt = epoch(day, seconds);
  if (!day || seconds >= 86400 || latitude < 20 || latitude > 55 || longitude < -130 || longitude > -60) return fail();
  const block = (offset: number, id: number) => {
    const start = b.readUInt32BE(offset) * 2;
    if (start < 120 || start + 10 > b.length || b.readInt16BE(start) !== -1 || b.readInt16BE(start + 2) !== id) return fail();
    const end = start + b.readUInt32BE(start + 4);
    if (end > b.length || end < start + 10) return fail();
    return b.subarray(start, end);
  };
  // Tabular block embeds another 120-byte header, then length-prefixed ASCII lines.
  const tab = block(116, 3);
  if (tab.length < 132 || tab.readInt16BE(8) !== 101 || tab.readInt16BE(128) !== -1) return fail();
  const pages = tab.readUInt16BE(130), lines: string[] = [];
  if (!pages || pages > 48) return fail();
  let cursor = 132;
  for (let page = 0; page < pages; page++) {
    for (;;) {
      if (cursor + 2 > tab.length) return fail();
      const length = tab.readInt16BE(cursor); cursor += 2;
      if (length === -1) break;
      if (length < 0 || length > 80 || cursor + length > tab.length || lines.length >= 2400) return fail();
      lines.push(tab.toString('ascii', cursor, cursor + length)); cursor += length;
    }
  }
  if (cursor !== tab.length) return fail();
  const interval = Number(/(\d+)\s+\(MIN\) FORECAST INTERVAL/.exec(lines.join('\n'))?.[1]);
  if (interval < 5 || interval > 60 || interval % 5 !== 0) return fail();
  const project = (x: number, y: number): [number, number] => {
    if (Math.abs(x) > 2048 || Math.abs(y) > 2048) return fail();
    const radians = Math.PI / 180, angle = Math.atan2(x, y), distance = Math.hypot(x, y) * .25 / 6371.0088, lat = latitude * radians;
    const next = Math.asin(Math.sin(lat) * Math.cos(distance) + Math.cos(lat) * Math.sin(distance) * Math.cos(angle));
    return [longitude + Math.atan2(Math.sin(angle) * Math.sin(distance) * Math.cos(lat), Math.cos(distance) - Math.sin(lat) * Math.sin(next)) / radians,
      next / radians].map(n => Math.round(n * 1e5) / 1e5) as [number, number];
  };
  const tracks: RadarCellTrack[] = [];
  const scan = { site, observedAt, source: `${RADAR_MOTION_ROOT}SI.${site.toLowerCase()}/sn.last`, sourceHash, tracks };
  // No detected cells is a valid report: NOAA omits the symbology block.
  if (b.readUInt32BE(108) === 0) {
    if (b.readUInt16BE(92) !== 0 || !isRadarMotionSnapshot({ schemaVersion: 1, scans: [scan] })) return fail();
    return scan;
  }
  const sym = block(108, 1), layers = sym.readUInt16BE(8);
  if (!layers || layers > 18) return fail();
  let at = 10;
  for (let layer = 0; layer < layers; layer++) {
    if (at + 6 > sym.length || sym.readInt16BE(at) !== -1) return fail();
    const end = at + 6 + sym.readUInt32BE(at + 2); at += 6;
    if (end > sym.length) return fail();
    let cell: { id: string; x: number; y: number } | undefined;
    while (at < end) {
      if (at + 4 > end) return fail();
      const code = sym.readUInt16BE(at), length = sym.readUInt16BE(at + 2), start = at + 4, stop = start + length;
      if (stop > end || !length || length % 2) return fail();
      if (code === 15) {
        if (length !== 6) return fail();
        cell = { id: sym.toString('ascii', start + 4, stop), x: sym.readInt16BE(start), y: sym.readInt16BE(start + 2) };
      } else if (code === 24) {
        if (!cell) return fail();
        let nested = start, coordinates: [number, number][] | undefined, stationary = false;
        while (nested < stop) {
          if (nested + 4 > stop) return fail();
          const kind = sym.readUInt16BE(nested), size = sym.readUInt16BE(nested + 2); nested += 4;
          if (nested + size > stop || !size) return fail();
          if (kind === 6) {
            if (coordinates || size < 8 || size > 20 || size % 4 || sym.readInt16BE(nested) !== cell.x || sym.readInt16BE(nested + 2) !== cell.y) return fail();
            coordinates = [];
            for (let p = nested; p < nested + size; p += 4) coordinates.push(project(sym.readInt16BE(p), sym.readInt16BE(p + 2)));
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
  if (at !== sym.length) return fail();
  if (!isRadarMotionSnapshot({ schemaVersion: 1, scans: [scan] })) return fail();
  return scan;
}
