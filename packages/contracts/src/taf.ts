import { isRecord, isNonEmptyString } from './validation.js';

/** AWC JSON TAF fields used by the raw forecast display. Heights are in feet. */
export type TafForecast = {
  timeFrom: number;
  timeTo: number;
  timeBec?: number | null;
  fcstChange?: string | null;
  probability?: number | null;
  visib?: number | string | null;
  vertVis?: number | null;
  clouds: Array<{ cover: string; base?: number | null }>;
};

export type TafReport = {
  icaoId: string;
  lat?: number | null;
  lon?: number | null;
  issueTime: string;
  dbPopTime?: string;
  validTimeFrom: number;
  validTimeTo: number;
  rawTAF: string;
  fcsts: TafForecast[];
};

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const optionalNumber = (value: unknown) => value == null || finite(value);
const timestamp = (value: unknown): value is number => finite(value) && Number.isFinite(new Date(value * 1000).getTime());

export function isTafReport(value: unknown): value is TafReport {
  return isRecord(value) && isNonEmptyString(value.icaoId) &&
    (value.lat == null || finite(value.lat) && Math.abs(value.lat) <= 90) &&
    (value.lon == null || finite(value.lon) && Math.abs(value.lon) <= 180) &&
    typeof value.issueTime === 'string' && Number.isFinite(Date.parse(value.issueTime)) &&
    (value.dbPopTime === undefined || typeof value.dbPopTime === 'string' && Number.isFinite(Date.parse(value.dbPopTime))) &&
    timestamp(value.validTimeFrom) && timestamp(value.validTimeTo) && value.validTimeTo >= value.validTimeFrom &&
    isNonEmptyString(value.rawTAF) && Array.isArray(value.fcsts) && value.fcsts.every(isTafForecast);
}

function isTafForecast(value: unknown): value is TafForecast {
  return isRecord(value) && timestamp(value.timeFrom) && timestamp(value.timeTo) && value.timeTo >= value.timeFrom &&
    (value.timeBec == null || timestamp(value.timeBec)) && optionalNumber(value.probability) && optionalNumber(value.vertVis) &&
    (value.fcstChange == null || typeof value.fcstChange === 'string') &&
    (value.visib == null || typeof value.visib === 'string' || finite(value.visib)) &&
    Array.isArray(value.clouds) && value.clouds.every(cloud => isRecord(cloud) &&
      typeof cloud.cover === 'string' && optionalNumber(cloud.base));
}
