import type {
  FeatureCollectionResponse,
  FlightCategory,
  GeoPointFeature,
  GeoPointProperties,
  MetarFeature,
  MetarFeatureCollection,
} from '@zlayer/contracts';
import { normalizeIdentifier } from './features.js';

const CATEGORY_SEVERITY: Record<FlightCategory, number> = {
  VFR: 0,
  MVFR: 1,
  IFR: 2,
  LIFR: 3,
};

const WEATHER_PROPERTY_NAMES = [
  'flightCategory',
  'displayFlightCategory',
  'metarStationId',
  'metarObservedAt',
  'metarCeilingFt',
  'metarCeilingStatus',
  'metarVisibilitySm',
  'metarWindDirection',
  'metarWindSpeedKt',
  'metarWindGustKt',
  'rawMetar',
  'weatherSource',
] as const;

export function mergeMetarsIntoAirports(
  airports: FeatureCollectionResponse,
  metars: MetarFeatureCollection,
  options: { weatherOnly?: boolean } = {},
): FeatureCollectionResponse {
  const latestByStation = indexLatestMetars(metars.features);
  const features: GeoPointFeature[] = [];
  for (const airport of airports.features) {
    const metar = latestAirportMetar(airport, latestByStation);
    // The weather overlay only needs reporting airports. Filter before cloning
    // thousands of static FAA records on each observation refresh.
    if (!metar && options.weatherOnly) continue;
    const properties = withoutWeatherProperties(airport.properties);
    features.push({ ...airport, properties: metar ? { ...properties, ...metarWeatherProperties(metar) } : properties });
  }
  return { ...airports, features };
}

/** Decoded observation fields, without borrowing an airport's identity or geometry. */
export function metarWeatherProperties(metar: MetarFeature): GeoPointProperties {
  const stationId = metarStationId(metar);
  const observedAt = normalizedObservationTime(metar.properties.obsTime);
  const ceiling = metarCeiling(metar);
  const visibilitySm = metarVisibilitySm(metar);
  const category = metarCategory(metar, ceiling, visibilitySm);
  return {
    ...(category ? { flightCategory: category } : {}),
    ...(stationId ? { metarStationId: stationId } : {}),
    ...(observedAt ? { metarObservedAt: observedAt } : {}),
    ...(ceiling.heightFt !== undefined ? { metarCeilingFt: ceiling.heightFt } : {}),
    metarCeilingStatus: ceiling.status,
    ...(visibilitySm !== undefined ? { metarVisibilitySm: visibilitySm } : {}),
    ...(metar.properties.wdir !== undefined
      ? { metarWindDirection: metar.properties.wdir }
      : {}),
    ...(metar.properties.wspd !== undefined
      ? { metarWindSpeedKt: metar.properties.wspd }
      : {}),
    ...(metar.properties.wgst !== undefined
      ? { metarWindGustKt: metar.properties.wgst }
      : {}),
    ...(metar.properties.rawOb !== undefined
      ? { rawMetar: metar.properties.rawOb }
      : {}),
    weatherSource: 'AWC',
  };
}

export function setFlightCategoryDisplay(
  airports: FeatureCollectionResponse,
  enabled: boolean,
): FeatureCollectionResponse {
  return {
    ...airports,
    features: airports.features.map((airport) => {
      const properties = { ...airport.properties };
      delete properties.displayFlightCategory;
      if (!properties.metarStationId) return { ...airport, properties };
      return {
        ...airport,
        properties: {
          ...properties,
          displayFlightCategory: enabled
            ? (properties.flightCategory ?? 'N/A')
            : 'N/A',
        },
      };
    }),
  };
}

export function weatherStationIdsForAirports(
  airports: FeatureCollectionResponse | undefined,
): string[] {
  if (!airports) return [];
  return [...new Set(airports.features
    .map(preferredWeatherStationId)
    .filter((station): station is string => station !== undefined))];
}

export function metarFlightCategory(metar: MetarFeature): FlightCategory | undefined {
  return metarCategory(metar, metarCeiling(metar), metarVisibilitySm(metar));
}

function metarCategory(metar: MetarFeature, ceiling: MetarCeiling, visibility: number | undefined): FlightCategory | undefined {
  const supplied = normalizeFlightCategory(metar.properties.fltcat) ??
    normalizeFlightCategory(metar.properties.fltCat);
  if (supplied) return supplied;

  const knownCeiling = ceiling.status === 'unknown' ? ceiling.upperBoundFt : ceiling.heightFt;
  const category = flightCategoryForConditions(knownCeiling, visibility);
  // Partial observations can establish a restriction, but an unknown ceiling cannot establish VFR.
  return ceiling.status === 'unknown' && category === 'VFR' ? undefined : category;
}

/** The more restrictive of ceiling (feet AGL) and visibility (statute miles). */
export function flightCategoryForConditions(ceiling: number | undefined, visibility: number | undefined): FlightCategory | undefined {
  const categories = [
    ceiling === undefined ? undefined : categoryForCeiling(ceiling),
    visibility === undefined ? undefined : categoryForVisibility(visibility),
  ].filter((category): category is FlightCategory => category !== undefined);
  if (categories.length === 0) return undefined;
  return categories.reduce((worst, category) =>
    CATEGORY_SEVERITY[category] > CATEGORY_SEVERITY[worst] ? category : worst,
  );
}

export function latestMetarObservation(
  metars: MetarFeatureCollection,
): string | undefined {
  const latest = metars.features.reduce<number | undefined>((current, metar) => {
    const epoch = metarObservationTime(metar);
    return epoch > (current ?? 0) ? epoch : current;
  }, undefined);
  return latest ? new Date(latest).toISOString() : undefined;
}

function indexLatestMetars(metars: MetarFeature[]): Map<string, MetarFeature> {
  const latestByStation = new Map<string, MetarFeature>();
  for (const metar of metars) {
    const station = metarStationId(metar);
    if (!station) continue;
    const current = latestByStation.get(station);
    if (!current || metarObservationTime(metar) > metarObservationTime(current)) {
      latestByStation.set(station, metar);
    }
  }
  return latestByStation;
}

function latestAirportMetar(
  airport: GeoPointFeature,
  latestByStation: Map<string, MetarFeature>,
): MetarFeature | undefined {
  return airportStationIds(airport)
    .map((station) => latestByStation.get(station))
    .filter((metar): metar is MetarFeature => metar !== undefined)
    .reduce<MetarFeature | undefined>(
      (latest, metar) =>
        !latest || metarObservationTime(metar) > metarObservationTime(latest) ? metar : latest,
      undefined,
    );
}

/** Requests use the published ICAO code; FAA aliases are only for joining reports. */
export function preferredWeatherStationId(airport: GeoPointFeature): string | undefined {
  return normalizeIdentifier(airport.properties.icaoId);
}

function airportStationIds(airport: GeoPointFeature): string[] {
  const icaoId = preferredWeatherStationId(airport);
  const faaId = normalizeIdentifier(airport.properties.faaId);
  return [...new Set([icaoId, faaId, faaId?.length === 3 ? `K${faaId}` : undefined].filter(
    (station): station is string => station !== undefined,
  ))];
}

function withoutWeatherProperties(properties: GeoPointProperties): GeoPointProperties {
  const cleanProperties = { ...properties };
  for (const property of WEATHER_PROPERTY_NAMES) delete cleanProperties[property];
  return cleanProperties;
}

function normalizeFlightCategory(value: unknown): FlightCategory | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toUpperCase().replaceAll('*', '');
  return normalized === 'VFR' || normalized === 'MVFR' || normalized === 'IFR' || normalized === 'LIFR'
    ? normalized
    : undefined;
}

export function metarStationId(metar: MetarFeature): string | undefined {
  return normalizeIdentifier(metar.properties.id) ??
    normalizeIdentifier(metar.properties.icaoId);
}

/** Milliseconds since the epoch, or zero when the observation time is unavailable. */
export function metarObservationTime(metar: MetarFeature): number {
  return parseObservationTime(metar.properties.obsTime) ?? 0;
}

function normalizedObservationTime(value: unknown): string | undefined {
  const epoch = parseObservationTime(value);
  return epoch === undefined ? undefined : new Date(epoch).toISOString();
}

function parseObservationTime(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const epoch = typeof value === 'number'
    ? (value > 10_000_000_000 ? value : value * 1000)
    : Date.parse(value);
  return Number.isFinite(new Date(epoch).getTime()) ? epoch : undefined;
}

type MetarCeiling =
  | { status: 'measured'; heightFt: number }
  | { status: 'none'; heightFt?: undefined }
  | { status: 'unknown'; heightFt?: undefined; upperBoundFt?: number };
const CEILING_COVERS = ['BKN', 'OVC', 'VV', 'OVX'];
const NON_CEILING_COVERS = ['FEW', 'SCT', 'SKC', 'CLR', 'NSC', 'NCD', 'CAVOK'];
const validCloudBase = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** A known ceiling layer bounds the ceiling even if another layer's base is unavailable. */
function ceilingFromBases(bases: readonly unknown[]): MetarCeiling | undefined {
  if (!bases.length) return undefined;
  const measured = bases.filter(validCloudBase);
  const lowestFt = measured.length ? Math.min(...measured) * 100 : undefined;
  if (measured.length === bases.length) return { status: 'measured', heightFt: lowestFt! };
  return { status: 'unknown', ...(lowestFt !== undefined ? { upperBoundFt: lowestFt } : {}) };
}

function metarCeiling(metar: MetarFeature): MetarCeiling {
  const { ceil, clouds = [], cover, rawOb } = metar.properties;
  // AWC GeoJSON reports ceiling and cloud bases in hundreds of feet AGL.
  if (validCloudBase(ceil)) return { status: 'measured', heightFt: ceil * 100 };
  const ceilings = clouds.filter(cloud => CEILING_COVERS.includes(String(cloud.cover).trim().toUpperCase()));
  const decoded = ceilingFromBases(ceilings.map(cloud => cloud.base));
  if (decoded?.status === 'measured') return decoded;
  // Only observation groups count: remarks and appended trends describe other conditions.
  const observation = rawOb?.toUpperCase().split(/\b(?:RMK|TEMPO|BECMG|NOSIG)\b/, 1)[0] ?? '';
  const rawClouds = [...observation.matchAll(/(?:^|\s)(FEW|SCT|BKN|OVC|VV)(\d{3}|\/{3})(?:CB|TCU)?(?=\s|=|$)/g)];
  const rawCeilings = rawClouds.filter(([, code]) => CEILING_COVERS.includes(code!));
  const raw = ceilingFromBases(rawCeilings.map(([, , base]) => base === '///' ? undefined : Number(base)));
  if (raw?.status === 'measured') return raw;
  if (decoded?.status === 'unknown' || raw?.status === 'unknown') {
    const bounds = [decoded, raw].flatMap(value => value?.status === 'unknown' && value.upperBoundFt !== undefined
      ? [value.upperBoundFt] : []);
    return { status: 'unknown', ...(bounds.length ? { upperBoundFt: Math.min(...bounds) } : {}) };
  }
  if (CEILING_COVERS.includes(String(cover).trim().toUpperCase())) return { status: 'unknown' };
  const noCeiling = clouds.length
    ? clouds.every(cloud => NON_CEILING_COVERS.includes(String(cloud.cover).trim().toUpperCase()))
    : NON_CEILING_COVERS.includes(String(cover).trim().toUpperCase());
  return { status: noCeiling || rawClouds.length || /(?:^|\s)(?:SKC|CLR|NSC|NCD|CAVOK)(?=\s|=|$)/.test(observation)
    ? 'none' : 'unknown' };
}

function metarVisibilitySm(metar: MetarFeature): number | undefined {
  const value = metar.properties.visib;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  return parseVisibility(value);
}

export function parseVisibility(value: string): number | undefined {
  const normalized = value.trim().toUpperCase().replace(/^[MP]/, '').replace(/\+$/, '');
  const [wholeOrFraction, fraction] = normalized.split(/\s+/, 2);
  if (!wholeOrFraction) return undefined;
  if (fraction) {
    const whole = Number.parseFloat(wholeOrFraction);
    const remainder = parseFraction(fraction);
    return Number.isFinite(whole) && remainder !== undefined ? whole + remainder : undefined;
  }
  return wholeOrFraction.includes('/')
    ? parseFraction(wholeOrFraction)
    : finiteNumber(Number.parseFloat(wholeOrFraction));
}

function parseFraction(value: string): number | undefined {
  const [numeratorText, denominatorText] = value.split('/', 2);
  const numerator = Number(numeratorText);
  const denominator = Number(denominatorText);
  return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0
    ? numerator / denominator
    : undefined;
}

function finiteNumber(value: number): number | undefined {
  return Number.isFinite(value) ? value : undefined;
}

function categoryForCeiling(ceilingFt: number): FlightCategory {
  if (ceilingFt < 500) return 'LIFR';
  if (ceilingFt < 1_000) return 'IFR';
  if (ceilingFt <= 3_000) return 'MVFR';
  return 'VFR';
}

function categoryForVisibility(visibilitySm: number): FlightCategory {
  if (visibilitySm < 1) return 'LIFR';
  if (visibilitySm < 3) return 'IFR';
  if (visibilitySm <= 5) return 'MVFR';
  return 'VFR';
}
