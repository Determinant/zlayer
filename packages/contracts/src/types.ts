import type { JsonReferenceIdentity } from './json-reference.js';
import type { RouteHistoryResource } from './route-history.js';
import type { ChartPackageIndex } from './chart-packages.js';
import type { PreferredRoutesResource } from './preferred-routes.js';

export type Bounds = [west: number, south: number, east: number, north: number];

export type ChartKind =
  | 'vfr-sectional'
  | 'vfr-terminal'
  | 'vfr-flyway'
  | 'ifr-low'
  | 'unknown';

export type ChartRecord = {
  id: string;
  title: string;
  kind: ChartKind;
  revision: string;
  format: 'mbtiles';
  bounds: Bounds;
  minZoom: number;
  maxZoom: number;
  byteLength: number;
  sha256: string;
  url: string;
};

export type NavigationLayerId = 'airports' | 'vfr-waypoints' | 'navaids' | 'fixes';

export type NavigationLayerRecord = JsonReferenceIdentity & {
  id: NavigationLayerId;
  title: string;
  count: number;
  sourceCount: number;
  minZoom: number;
  url: string;
};

export type AirwayResourceRecord = JsonReferenceIdentity & {
  id: 'airways';
  title: string;
  count: number;
  sourceCount: number;
  url: string;
};

export type ProcedureKind =
  | 'airport-diagram'
  | 'approach'
  | 'departure'
  | 'arrival'
  | 'takeoff-minimums'
  | 'diverse-vector-area'
  | 'alternate-minimums'
  | 'radar-minimums'
  | 'hot-spot'
  | 'lahso'
  | 'other';

export type ProcedureResourceRecord = JsonReferenceIdentity & {
  id: 'procedures';
  title: string;
  cycle: string;
  effectiveDate: string;
  expirationDate: string;
  airportCount: number;
  sourceAirportCount: number;
  procedureCount: number;
  sourceProcedureCount: number;
  url: string;
};

export type ProcedureVolumeTarget = {
  volumeId: string;
  section: string | null;
  printedPage: string | null;
  pageIndex: number | null;
};

export type ProcedureRecord = {
  id: string;
  kind: ProcedureKind;
  name: string;
  sortOrder: number;
  pdfName: string;
  pdfUrl: string;
  namedDestination: string | null;
  volumeTarget: ProcedureVolumeTarget | null;
  source: {
    chartSequence: string;
    chartCode: string;
    userAction: string | null;
    changeNoticeFlag: string | null;
    changeNoticeSection: string | null;
    changeNoticePage: string | null;
    procedureId: string | null;
    twoColored: string | null;
    civil: string | null;
    faaComputerCode: string | null;
    copter: string | null;
    amendmentNumber: string | null;
    amendmentDate: string | null;
    extraFields: Record<string, string>;
  };
};

export type ProcedureAirport = {
  id: string;
  faaId: string;
  icaoId: string | null;
  name: string;
  city: string;
  state: string;
  volumeId: string;
  military: boolean;
  sortCode: string;
  procedures: ProcedureRecord[];
};

export type ProcedureVolume = {
  id: string;
  url: string;
  byteLength: number;
  sha256: string;
  pageCount: number;
  resolvedTargetCount: number;
  unresolvedTargetCount: number;
};

export type ProcedureCatalog = {
  schemaVersion: 1;
  builderVersion: number;
  cycle: string;
  effectiveDate: string;
  expirationDate: string;
  generatedAt: string;
  faaPdfBaseUrl: string;
  sourceXml: {
    url: string;
    sha256: string;
  };
  volumes: ProcedureVolume[];
  airports: ProcedureAirport[];
};

export type AirwaySegment = {
  sequence: number;
  from: string;
  /** FAA AWY_SEG_GAP_FLAG: a gap is not a traversable airway leg. */
  gap: boolean;
  fromType?: string;
  to?: string;
  magneticCourse?: number;
  oppositeMagneticCourse?: number;
  distanceNm?: number;
  meaFt?: number;
  oppositeMeaFt?: number;
  gpsMeaFt?: number;
  mocaFt?: number;
  maxAuthorizedAltitudeFt?: number;
  state?: string;
  country?: string;
  icaoRegion?: string;
  artcc?: string;
  remark?: string;
};

export type AirwayRecord = {
  id: string;
  ident: string;
  location?: string;
  regulatory?: boolean;
  updatedAt?: string;
  points: string[];
  remark?: string;
  segments: AirwaySegment[];
};

export type AirwayDataResponse = {
  type: 'ZLayerAirways';
  metadata: {
    effectiveDate: string;
    source: string;
  };
  airways: AirwayRecord[];
};

export type ProductStatus = 'current' | 'stale' | 'unavailable' | 'planned';
export type FlightCategory = 'VFR' | 'MVFR' | 'IFR' | 'LIFR';
export type DisplayFlightCategory = FlightCategory | 'N/A';

export type MetarCloud = {
  cover?: string | null;
  base?: number | null;
};

export type MetarProperties = Record<string, unknown> & {
  id?: string;
  icaoId?: string;
  site?: string;
  obsTime?: string | number;
  fltcat?: string | null;
  fltCat?: string | null;
  visib?: string | number | null;
  ceil?: number | null;
  cover?: string | null;
  clouds?: MetarCloud[];
  wdir?: string | number | null;
  wspd?: number | null;
  wgst?: number | null;
  rawOb?: string;
};

export type MetarFeature = {
  type: 'Feature';
  geometry: PointGeometry;
  properties: MetarProperties;
};

export type MetarFeatureCollection = {
  type: 'FeatureCollection';
  features: MetarFeature[];
};

export type WeatherProductRecord = {
  id: string;
  title: string;
  status: ProductStatus;
};

export type CatalogResponse = {
  schemaVersion: 1;
  generatedAt: string;
  revision: string;
  charts: ChartRecord[];
  chartPackages?: ChartPackageIndex & { root: string };
  navigation: NavigationLayerRecord[];
  airways?: AirwayResourceRecord;
  terminalProcedures?: import('./terminal-procedures.js').TerminalProceduresResource;
  preferredRoutes?: PreferredRoutesResource;
  routeHistory?: RouteHistoryResource;
  procedures?: ProcedureResourceRecord;
  weather: WeatherProductRecord[];
};

export type PointGeometry = {
  type: 'Point';
  coordinates: [longitude: number, latitude: number];
};

export type AirportRunwayEnd = {
  id: string;
  trueHeadingDeg?: number;
  trafficPattern?: 'left' | 'right';
};

export type AirportRunway = {
  id: string;
  lengthFt?: number;
  widthFt?: number;
  surface?: string;
  condition?: string;
  lighting?: string;
  ends?: AirportRunwayEnd[];
};

export type AirportFrequency = {
  type: 'ATIS' | 'D-ATIS' | 'AWOS' | 'ASOS' | 'TOWER' | 'CTAF' | 'GROUND';
  frequencyMHz: number;
  /** Published FAA use, including primary/secondary and weather system subtype. */
  use?: string;
  sector?: string;
  /** FAA TOWER_HRS, describing the tower rather than this individual service. */
  hours?: string;
  remarks?: string;
};

export type GeoPointProperties = Record<string, unknown> & {
  // Assigned by the client when composing navigation from multiple saved sources.
  dataRevision?: string;
  dataSourceKey?: string;
  kind?: string;
  ident?: string;
  faaId?: string;
  icaoId?: string;
  name?: string;
  city?: string;
  state?: string;
  type?: string;
  facilityType?: string;
  use?: string;
  towered?: boolean;
  elevationFt?: number;
  frequency?: string;
  frequencies?: AirportFrequency[];
  /** Published VOR station alignment relative to true north; east positive. */
  stationDeclinationDeg?: number;
  longestRunwayFt?: number;
  runways?: AirportRunway[];
  lowArtcc?: string;
  flightCategory?: FlightCategory;
  displayFlightCategory?: DisplayFlightCategory;
  metarStationId?: string;
  metarObservedAt?: string;
  metarCeilingFt?: number;
  metarCeilingStatus?: 'measured' | 'none' | 'unknown';
  metarVisibilitySm?: number;
  metarWindDirection?: string | number | null;
  metarWindSpeedKt?: number | null;
  metarWindGustKt?: number | null;
  rawMetar?: string;
  weatherSource?: string;
};

export type GeoPointFeature = {
  type: 'Feature';
  id?: string;
  geometry: PointGeometry;
  properties: GeoPointProperties;
};

export type FeatureCollectionResponse = {
  type: 'FeatureCollection';
  features: GeoPointFeature[];
  meta: {
    revision: string;
    layer: NavigationLayerId;
    returned: number;
    truncated: boolean;
  };
};

export type NavigationData = Partial<Record<NavigationLayerId, FeatureCollectionResponse>>;

export type SearchResult = {
  layer: NavigationLayerId;
  feature: GeoPointFeature;
  score: number;
};

export type SearchResponse = {
  schemaVersion: 1;
  query: string;
  results: SearchResult[];
};
