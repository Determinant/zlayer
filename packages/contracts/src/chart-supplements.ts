export type ChartSupplementVolume = {
  id: string;
  url: string;
  byteLength: number;
  sha256: string;
  pageCount: number;
};

export type ChartSupplementAirport = {
  faaId: string;
  name: string;
  city: string;
  state: string;
  volumeId: string;
  printedPage: string;
  pageIndex: number;
};

export type ChartSupplementCatalog = {
  schemaVersion: 1 | 2;
  builderVersion: number;
  effectiveDate: string;
  expirationDate: string;
  generatedAt: string;
  sourceXml: { url: string; sha256: string };
  volumes: ChartSupplementVolume[];
  airports: ChartSupplementAirport[];
  /** All FAA index targets, including those whose regional book is unavailable. */
  expected?: ChartSupplementTarget[];
};
export type ChartSupplementTarget = Pick<ChartSupplementAirport, 'faaId' | 'state' | 'volumeId' | 'printedPage'>;
export const supplementTargetKey = (target: ChartSupplementTarget) => `${target.faaId}:${target.volumeId}:${target.printedPage}`;

export function isSupplementTarget(value: unknown): value is ChartSupplementTarget {
  return record(value) && text(value.faaId) && /^[A-Z0-9]{1,4}$/.test(value.faaId) && typeof value.state === 'string' &&
    text(value.volumeId) && REGIONS.has(value.volumeId) && text(value.printedPage) && /^\d+$/.test(value.printedPage);
}

export function bookUrl(volume: ChartSupplementVolume, catalogUrl: string): string {
  const address = new URL(volume.url, catalogUrl);
  address.searchParams.set('sha256', volume.sha256.toLowerCase());
  address.searchParams.set('bytes', String(volume.byteLength));
  return address.href;
}

const REGIONS = new Set(['AK', 'EC', 'NC', 'NE', 'NW', 'PAC', 'SC', 'SE', 'SW']);

export function isChartSupplementCatalog(value: unknown, revision?: string): value is ChartSupplementCatalog {
  if (!record(value) || (value.schemaVersion !== 1 && value.schemaVersion !== 2) || !count(value.builderVersion) ||
      !date(value.effectiveDate) || !date(value.expirationDate) || value.expirationDate <= value.effectiveDate ||
      (revision !== undefined && (revision < value.effectiveDate || revision >= value.expirationDate)) ||
      !text(value.generatedAt) || !Number.isFinite(Date.parse(value.generatedAt)) ||
      !record(value.sourceXml) || !text(value.sourceXml.url) || !hash(value.sourceXml.sha256) ||
      !Array.isArray(value.volumes) || !value.volumes.length || !Array.isArray(value.airports)) return false;
  const volumes = new Map<string, number>();
  for (const volume of value.volumes) {
    if (!record(volume) || !text(volume.id) || !REGIONS.has(volume.id) || volumes.has(volume.id) ||
        !text(volume.url) || !hash(volume.sha256) || !count(volume.byteLength) || !volume.byteLength ||
        !count(volume.pageCount) || !volume.pageCount) return false;
    volumes.set(volume.id, volume.pageCount);
  }
  const targets = new Set<string>();
  for (const airport of value.airports) {
    if (!record(airport) || !text(airport.faaId) || !/^[A-Z0-9]{1,4}$/.test(airport.faaId) ||
        !text(airport.name) || typeof airport.city !== 'string' || typeof airport.state !== 'string' ||
        !text(airport.volumeId) || !volumes.has(airport.volumeId) ||
        !text(airport.printedPage) || !/^\d+$/.test(airport.printedPage) ||
        !count(airport.pageIndex) || airport.pageIndex >= volumes.get(airport.volumeId)!) return false;
    const key = `${airport.faaId}:${airport.volumeId}:${airport.pageIndex}`;
    if (targets.has(key)) return false;
    targets.add(key);
  }
  if (!targets.size) return false;
  if (value.schemaVersion === 1) return value.expected === undefined;
  if (!Array.isArray(value.expected) || !value.expected.length || !value.expected.every(isSupplementTarget)) return false;
  const expected = new Map(value.expected.map(target => [supplementTargetKey(target), target.state]));
  return expected.size === value.expected.length && value.airports.every(airport => expected.get(supplementTargetKey(airport)) === airport.state);
}
import { isRecord as record, isNonEmptyString as text, isSha256 as hash,
  isNonNegativeInteger as count, isIsoDate as date } from './validation.js';
