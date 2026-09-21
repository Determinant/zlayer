import type { MetarFeature, PointGeometry, TafReport } from '@zlayer/contracts';
import { distanceNm, metarObservationTime, metarStationId, normalizeIdentifier } from '@zlayer/domain';
import { compassDirection, proximityBoxes } from '../../core/geo/proximity';
import { METAR_LOOKBACK_HOURS } from './metar/requests';

export const NEARBY_STATION_RADIUS_NM = 50;
export type WeatherReport = MetarFeature | TafReport;
export type NearbyStation<Report extends WeatherReport> = { stationId: string; report: Report; distanceNm: number; direction: string };
type Point = PointGeometry['coordinates'];
const isMetar = (report: WeatherReport): report is MetarFeature => 'type' in report && report.type === 'Feature';
const stationId = (report: WeatherReport) => isMetar(report) ? metarStationId(report) : normalizeIdentifier(report.icaoId);
const usable = (report: WeatherReport) => isMetar(report)
  ? !/\bNIL\b/i.test(report.properties.rawOb ?? '') : !/\b(?:CNL|NIL)\b/i.test(report.rawTAF);

export function hasCurrentReport(report: WeatherReport | undefined, now: number): boolean {
  if (!report || !usable(report)) return false;
  if (!isMetar(report)) return report.validTimeTo * 1000 > now;
  const observedAt = metarObservationTime(report);
  return observedAt > 0 && observedAt <= now && now - observedAt <= METAR_LOOKBACK_HOURS * 60 * 60_000;
}

function coordinates(report: WeatherReport): Point | undefined {
  if (!isMetar(report)) return typeof report.lon === 'number' && typeof report.lat === 'number'
    ? [report.lon, report.lat] : undefined;
  const [longitude, latitude] = report.geometry.coordinates;
  return Number.isFinite(longitude) && Number.isFinite(latitude) && Math.abs(latitude) <= 90
    ? report.geometry.coordinates : undefined;
}

export function stationDistance(point: Point, report: WeatherReport): number {
  const location = coordinates(report);
  return location ? distanceNm(point, location) : Infinity;
}

export function nearbyStationBoxes(point: Point): string[] {
  return proximityBoxes(point, NEARBY_STATION_RADIUS_NM);
}

function rankStations<Report extends WeatherReport>(stations: NearbyStation<Report>[], now: number): NearbyStation<Report>[] {
  return stations.sort((a, b) => Number(hasCurrentReport(b.report, now)) - Number(hasCurrentReport(a.report, now)) ||
    a.distanceNm - b.distanceNm || a.stationId.localeCompare(b.stationId));
}

export function nearbyStations<Report extends WeatherReport>(point: Point, reports: readonly Report[], now: number): NearbyStation<Report>[] {
  const stations = reports.flatMap((report): NearbyStation<Report>[] => {
    const id = stationId(report), location = coordinates(report);
    if (!id || !/^[A-Z0-9]{4}$/.test(id) || !location || !usable(report)) return [];
    const distance = distanceNm(point, location);
    if (!Number.isFinite(distance) || distance > NEARBY_STATION_RADIUS_NM) return [];
    return [{ stationId: id, report, distanceNm: distance, direction: compassDirection(point, location) }];
  });
  return rankStations(stations, now);
}

/** Include saved local reports even when stale or missing station coordinates. */
export function stationChoices<Report extends WeatherReport>(own: Report | undefined, nearby: readonly NearbyStation<Report>[], now: number): NearbyStation<Report>[] {
  const id = own && stationId(own);
  const local = own && id && usable(own) ? [{ stationId: id, report: own, distanceNm: 0, direction: '' }] : [];
  return rankStations([...local, ...nearby.filter(station => station.stationId !== id)], now);
}
