import { isRecord, isSha256 } from './validation.js';

export const PROGS_COVERAGE_SOURCE = 'https://aviationweather.gov/api/data/progchart';
export const PROGS_COVERAGE_MAX_BYTES = 1024 * 1024;
export const PROGS_COVERAGE_CATALOG_MAX_BYTES = 64 * 1024;
/** AWC's NDFD image extent, in Web Mercator, west/south/east/north. */
export const PROGS_COVERAGE_BOUNDS = [-134.691116, 18.898478, -61.308891, 56.152813] as const;
export type ProgsCoverageFile = { path: string; sha256: string; byteLength: number };
export type ProgsCoverageFrame = {
  validTime: number;
  /** WPC chart naming cycle; this is not an NDFD model run or issuance time. */
  chartReferenceTime: number;
  source: string;
  checkedAt: number;
  /** Absent only when the corresponding AWC image returned HTTP 404. */
  file?: ProgsCoverageFile;
};
export type ProgsCoverageCatalog = {
  schemaVersion: 1;
  source: typeof PROGS_COVERAGE_SOURCE;
  sourceHash: string;
  sourceCatalog: string;
  checkedAt: number;
  frames: ProgsCoverageFrame[];
};

export function progsCoverageSource(validTime: number, chartReferenceTime: number): string {
  const date = new Date(chartReferenceTime).toISOString(), day = date.slice(0, 10).replaceAll('-', '');
  const lead = String((validTime - chartReferenceTime) / 3600_000).padStart(3, '0');
  return `https://aviationweather.gov/data/products/wpc/${day}/${day}_${date.slice(11, 13)}_F${lead}_ndfd_sfc_wx_m.png`;
}
const instant = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v < 8.64e15;
export function isProgsCoverageCatalog(v: unknown): v is ProgsCoverageCatalog {
  if (!isRecord(v) || v.schemaVersion !== 1 || v.source !== PROGS_COVERAGE_SOURCE || !isSha256(v.sourceHash) ||
    !instant(v.checkedAt) || typeof v.sourceCatalog !== 'string' || !v.sourceCatalog || v.sourceCatalog.length > 16 * 1024 ||
    !Array.isArray(v.frames) || !v.frames.length || v.frames.length > 32) return false;
  const checkedAt = v.checkedAt;
  if (v.frames.filter(frame => isRecord(frame) && frame.validTime === frame.chartReferenceTime).length !== 1) return false;
  let previous = 0, bytes = 0;
  return v.frames.every((frame: unknown) => {
    if (!isRecord(frame) || !instant(frame.validTime) || !instant(frame.chartReferenceTime) || !instant(frame.checkedAt) ||
      frame.validTime <= previous || frame.checkedAt < checkedAt || frame.chartReferenceTime > frame.checkedAt + 60_000 ||
      frame.validTime % 3600_000 !== 0 || frame.chartReferenceTime % 3600_000 !== 0 ||
      frame.validTime < frame.chartReferenceTime || frame.validTime > frame.chartReferenceTime + 168 * 3600_000 ||
      frame.source !== progsCoverageSource(frame.validTime, frame.chartReferenceTime)) return false;
    previous = frame.validTime;
    if (frame.file === undefined) return true;
    const file = frame.file;
    if (!isRecord(file) || !isSha256(file.sha256) || file.path !== `coverage/${file.sha256}.png` ||
      typeof file.byteLength !== 'number' || !Number.isSafeInteger(file.byteLength) || file.byteLength < 45 || file.byteLength > PROGS_COVERAGE_MAX_BYTES) return false;
    bytes += file.byteLength;
    return bytes <= 8 * PROGS_COVERAGE_MAX_BYTES;
  });
}

/** Check dimensions before allocating a decoder. CRC/pixels are checked by the
 * server; the browser authenticates those exact bytes before decoding. */
export function progsCoverageImageSize(bytes: Uint8Array): { width: number; height: number } {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 45 || bytes.length > PROGS_COVERAGE_MAX_BYTES || signature.some((v, i) => bytes[i] !== v)) throw new Error('Invalid NDFD PNG');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16), height = view.getUint32(20);
  if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452 ||
    !(width === 900 && height === 600 || width === 1800 && height === 1200) ||
    bytes[24] !== 8 || bytes[25] !== 6 || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] !== 0 ||
    view.getUint32(bytes.length - 12) !== 0 || view.getUint32(bytes.length - 8) !== 0x49454e44) throw new Error('Unsupported NDFD image geometry or encoding');
  return { width, height };
}
