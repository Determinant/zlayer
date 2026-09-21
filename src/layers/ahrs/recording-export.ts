import { isRecord } from '@zlayer/contracts';
import type { AhrsSnapshot } from './layer';
import type { RecordingInfo } from './recording-storage';

export const GPX_NAMESPACE = 'http://www.topografix.com/GPX/1/1';
export const AHRS_NAMESPACE = 'urn:zlayer:ahrs:1';
export const EXPORT_CHUNK_BYTES = 64 * 1024;
const MAX_LINE_CHARACTERS = 1024 * 1024;
type Event = { sequence: number; time: number; type: string; data: Record<string, unknown> };
type Source = () => AsyncIterable<Blob>;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const xml = (value: unknown) => String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const attributes = (values: Record<string, unknown>) => Object.entries(values)
  .filter(([, value]) => (typeof value === 'string' && !['Infinity', '-Infinity', 'NaN'].includes(value)) || typeof value === 'boolean' || finite(value))
  .map(([key, value]) => ` ${key}="${xml(value)}"`).join('');
const vector = (value: unknown) => Array.isArray(value) && value.every(finite) ? value.join(' ') : undefined;
const timestamp = (value: unknown) => finite(value) && Math.abs(value) <= 8.64e15 ? new Date(value).toISOString() : undefined;
// GPX decimal fields cannot contain exponent notation. Preserve practical GPS precision.
const decimal = (value: number) => value.toFixed(9).replace(/\.?0+$/, '') || '0';

/** Bound reads even when the browser exposes a large disk-backed Blob. */
export async function* recordingBytes(chunks: AsyncIterable<Blob>): AsyncGenerator<Uint8Array<ArrayBuffer>> {
  for await (const chunk of chunks) {
    for (let offset = 0; offset < chunk.size; offset += EXPORT_CHUNK_BYTES) {
      const end = Math.min(chunk.size, offset + EXPORT_CHUNK_BYTES);
      const buffer = await chunk.slice(offset, end).arrayBuffer();
      yield new Uint8Array(buffer);
    }
  }
}

async function* lines(chunks: AsyncIterable<Blob>): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  for await (const bytes of recordingBytes(chunks)) {
    pending += decoder.decode(bytes, { stream: true });
    let start = 0, end: number;
    while ((end = pending.indexOf('\n', start)) !== -1) {
      if (end - start > MAX_LINE_CHARACTERS) throw new Error('A recording entry is too large to export.');
      const line = pending.slice(start, end).trim();
      start = end + 1;
      if (line) yield line;
    }
    pending = pending.slice(start);
    if (pending.length > MAX_LINE_CHARACTERS) throw new Error('A recording entry is too large to export.');
  }
  pending += decoder.decode();
  if (pending.trim()) yield pending.trim();
}

async function* events(source: Source): AsyncGenerator<Event> {
  let sequence = 0;
  for await (const line of lines(source())) {
    const value: unknown = JSON.parse(line);
    if (!isRecord(value) || value.sequence !== sequence++ || !finite(value.time) || typeof value.type !== 'string')
      throw new Error('The recording has invalid or missing entries. Download the debug log to inspect it.');
    if (sequence === 1 && (value.type !== 'header' || !isRecord(value.data) ||
      value.data.format !== 'zlayer-ahrs' || value.data.version !== 1)) throw new Error('Unsupported recording format.');
    yield { sequence: value.sequence as number, time: value.time, type: value.type,
      data: isRecord(value.data) ? value.data : {} };
  }
  if (!sequence) throw new Error('The recording is empty.');
}

/** Two sequential passes retain all AHRS samples at their own times without
 * buffering a flight or inventing extra GPS positions for faster attitude data. */
async function* gpx(source: Source, info: RecordingInfo): AsyncGenerator<string> {
  let context: Record<string, unknown> = {}, origin = 0, points = 0, segment = false, ended = false;
  let lastFix = -Infinity;
  const started = timestamp(info.startedAt);
  if (!started) throw new Error('The recording has an invalid start time.');
  yield `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="ZLayer" xmlns="${GPX_NAMESPACE}" xmlns:z="${AHRS_NAMESPACE}">\n`;
  yield `<metadata><name>AHRS recording ${started}</name><time>${started}</time></metadata>\n<trk><name>Recorded GPS track</name>\n`;
  for await (const event of events(source)) {
    if (event.type === 'header') {
      context = isRecord(event.data.context) ? event.data.context : {};
      if (!finite(context.timeOrigin) || !timestamp(context.timeOrigin)) throw new Error('The recording has no valid time origin.');
      origin = context.timeOrigin;
    }
    if (event.type === 'end') ended = true;
    if (event.type === 'calibrate' || event.type === 'stop' ||
      (event.type === 'gps' && event.data.state !== 'tracking')) {
      if (segment) { yield '</trkseg>\n'; segment = false; }
    }
    if (event.type !== 'gps' || event.data.state !== 'tracking' || !isRecord(event.data.fix)) continue;
    const fix = event.data.fix, coordinates = fix.coordinates;
    if (!Array.isArray(coordinates) || !finite(coordinates[0]) || !finite(coordinates[1]) ||
      Math.abs(coordinates[0]) > 180 || Math.abs(coordinates[1]) > 90 || !finite(fix.timestamp) ||
      !timestamp(fix.timestamp) || fix.timestamp <= lastFix) continue;
    if (segment && fix.timestamp - lastFix > 10_000) { yield '</trkseg>\n'; segment = false; }
    if (!segment) { yield '<trkseg>\n'; segment = true; }
    lastFix = fix.timestamp; points++;
    yield `<trkpt lat="${decimal(coordinates[1])}" lon="${decimal(coordinates[0] === 180 ? -180 : coordinates[0])}">` +
      (finite(fix.altitude) && Math.abs(fix.altitude) < 1e21 ? `<ele>${decimal(fix.altitude)}</ele>` : '') + `<time>${timestamp(fix.timestamp)}</time>` +
      `<extensions><z:gps${attributes({ speed: fix.speed, course: fix.track, accuracy: fix.accuracy,
        altitudeAccuracy: fix.altitudeAccuracy, estimatedVelocity: fix.estimated,
        receivedTime: timestamp(origin + event.time * 1000) })}/></extensions></trkpt>\n`;
  }
  if (!points) throw new Error('No GPS positions were saved. Download the debug log instead.');
  if (segment) yield '</trkseg>\n';
  yield `</trk>\n<extensions><z:recording${attributes({ version: 1, id: info.id, complete: ended,
    estimatorModel: context.estimatorModel, timeOrigin: origin, angles: 'degrees', distance: 'meters',
    speed: 'meters/second', gyroBiasUnits: 'radians/second', accelBiasUnits: 'meters/second^2',
    altitudeReference: 'browser-geolocation-wgs84-ellipsoid',
    attitudeFrame: 'body-forward-right-down-to-local-level', quaternionOrder: 'w x y z' })}>\n`;
  yield `<z:configuration>${xml(JSON.stringify({ mount: context.mount, trueHeading: context.trueHeading,
    trim: context.trim, estimatorOptions: context.estimatorOptions }))}</z:configuration>\n`;
  for await (const event of events(source)) {
    const time = timestamp(origin + event.time * 1000);
    if (!time) throw new Error('The recording contains an invalid timestamp.');
    if (event.type === 'state' || (event.type === 'header' && isRecord(context.snapshot))) {
      const state = (event.type === 'state' ? event.data : context.snapshot) as AhrsSnapshot;
      const a = state.attitude;
      yield `<z:state${attributes({ time, t: event.time, phase: state.phase, warning: state.warning, crossed: state.crossed,
        roll: a?.roll, pitch: a?.pitch, yaw: a?.yaw, quaternion: vector(a?.quaternion),
        headingReference: a?.headingReference, headingStatus: a?.headingStatus, status: a?.status,
        rollStd: finite(a?.attitudeStd?.[0]) ? a.attitudeStd[0] : undefined,
        pitchStd: finite(a?.attitudeStd?.[1]) ? a.attitudeStd[1] : undefined,
        headingStd: finite(a?.attitudeStd?.[2]) ? a.attitudeStd[2] : undefined,
        tiltStd: a?.tiltStd, imuAge: a?.age, load: a?.load, verticalSpeed: a?.verticalSpeed,
        gyroBias: vector(a?.bias), accelBias: vector(a?.accelBias),
        gpsAiding: a?.gpsAiding, tiltAiding: a?.tiltAiding, magneticAiding: a?.magneticFusion?.active })}/>\n`;
    } else if (['calibrate', 'alignment', 'issue', 'magnetic-issue', 'stop', 'end', 'visibility', 'document-visibility'].includes(event.type)) {
      yield `<z:event${attributes({ time, t: event.time, type: event.type })}>${xml(JSON.stringify(event.data))}</z:event>\n`;
    }
  }
  yield '</z:recording></extensions>\n</gpx>\n';
}

/** Coalesce small XML fragments, then encode bounded output pieces. */
export async function* recordingGpx(source: Source, info: RecordingInfo): AsyncGenerator<Uint8Array<ArrayBuffer>> {
  const encoder = new TextEncoder();
  let pending = '';
  for await (const text of gpx(source, info)) {
    pending += text;
    if (pending.length < 16 * 1024) continue;
    const bytes = encoder.encode(pending); pending = '';
    for (let offset = 0; offset < bytes.length; offset += EXPORT_CHUNK_BYTES) yield bytes.slice(offset, offset + EXPORT_CHUNK_BYTES);
  }
  if (pending) yield encoder.encode(pending);
}
