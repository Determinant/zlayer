import { isMagneticModel, type MagneticModel } from '../../core/geo/magnetic-model';
import type {
  Bounds,
  CatalogResponse,
  ChartKind,
  ChartRecord,
  NavigationLayerId,
  NavigationLayerRecord,
} from '@zlayer/contracts';
import { isRouteHistoryResource, type RouteHistoryResource, isChartPackageIndex, type ChartPackageIndex } from '@zlayer/contracts';
import { chartRoot } from './feed';
import { isTerrainManifest } from '@zlayer/contracts';
import { isSupportedCycle } from './cycles';
import { fetchJson, JsonResponseError } from '../../core/data/fetch-json';
import { isRecord, isNonEmptyString, isNonNegativeInteger as isCount, isIsoDate,
  isStrictBounds as isBounds, hasUniqueStrings } from '@zlayer/contracts';

export type CatalogIssue = { product: 'charts' | 'navigation' | 'procedures' | 'route-history' | 'terrain'; message: string };
export type ChartCatalog = CatalogResponse & { issues: CatalogIssue[] };

const PUBLISHED_CHART_KINDS = new Set<Exclude<ChartKind, 'unknown'>>([
  'vfr-sectional',
  'vfr-terminal',
  'vfr-flyway',
  'ifr-low',
]);

type NavigationProduct = {
  id: string;
  file: string;
  count: number;
  compression?: unknown; routeCount?: unknown; bytes?: unknown; uncompressedBytes?: unknown;
  source?: unknown; observationRange?: unknown;
};

type NavigationManifest = {
  effectiveDate: string;
  generatedAt: string;
  products: NavigationProduct[];
};

type ProcedureManifest = {
  cycle: string;
  effectiveDate: string;
  expirationDate: string;
  generatedAt: string;
  airportCount: number;
  procedureCount: number;
};

type PublishedChart = {
  id: string;
  title: string;
  kind: Exclude<ChartKind, 'unknown'>;
  file: string;
  bounds: Bounds;
  minZoom: number;
  maxZoom: number;
  byteLength: number;
  sha256: string;
  cutlineProvenance: string;
};

type ChartManifest = {
  effectiveDate: string;
  generatedAt: string;
  charts: PublishedChart[];
} & ({ schemaVersion: 1 } | ({ schemaVersion: 2; packagingVersion: 1 } & ChartPackageIndex));

type NavigationDefinition = {
  id: NavigationLayerId;
  title: string;
  minZoom: number;
};

const NAVIGATION: readonly NavigationDefinition[] = [
  { id: 'airports', title: 'Airports', minZoom: 6 },
  { id: 'vfr-waypoints', title: 'VFR waypoints', minZoom: 7 },
  { id: 'navaids', title: 'NAVAIDs', minZoom: 7 },
  { id: 'fixes', title: 'IFR fixes', minZoom: 9 },
];

/** Revalidate one navigation product without replacing a saved catalog's edition. */
export async function fetchNavigationLayer(revision: string, id: NavigationLayerId,
  signal?: AbortSignal): Promise<NavigationLayerRecord> {
  if (!isSupportedCycle(revision)) throw new Error(`Unsupported FAA cycle: ${revision}`);
  const manifest = await fetchNavigationManifest(revision, signal);
  return navigationLayer(revision, manifest, NAVIGATION.find(layer => layer.id === id)!);
}

async function fetchNavigationManifest(revision: string, signal?: AbortSignal): Promise<NavigationManifest> {
  return fetchDocument(`${chartRoot()}/${revision}/nav/manifest.json`, isNavigationManifest,
    'FAA navigation manifest', revision, signal);
}

/** Optional geographic model; discovery uses the selected cycle and configured feed. */
export async function fetchMagneticModelResource(revision: string, signal?: AbortSignal) {
  if (!isSupportedCycle(revision)) throw new Error(`Unsupported FAA cycle: ${revision}`);
  const manifest = await fetchNavigationManifest(revision, signal);
  const product = requiredProduct(new Map(manifest.products.map(item => [item.id, item])), 'magnetic-model');
  return { count: product.count,
    url: `${chartRoot()}/${revision}/nav/${product.file}?v=${encodeURIComponent(manifest.generatedAt)}` };
}

function navigationLayer(revision: string, manifest: NavigationManifest,
  definition: NavigationDefinition): NavigationLayerRecord {
  const product = requiredProduct(new Map(manifest.products.map(product => [product.id, product])), definition.id);
  return { ...definition, count: product.count, sourceCount: product.count,
    url: `${chartRoot()}/${revision}/nav/${product.file}?v=${encodeURIComponent(manifest.generatedAt)}` };
}

export function isInsideChartCoverage(
  [longitude, latitude]: [number, number],
  charts: readonly Pick<ChartRecord, 'bounds'>[],
): boolean {
  return charts.some(({ bounds: [west, south, east, north] }) =>
    longitude >= west && longitude <= east && latitude >= south && latitude <= north
  );
}

export async function fetchChartCatalog(revision: string, signal?: AbortSignal): Promise<ChartCatalog> {
  if (!isSupportedCycle(revision)) throw new Error(`Unsupported FAA cycle: ${revision}`);
  const revisionRoot = `${chartRoot()}/${revision}`;
  const issues: CatalogIssue[] = [];
  const load = async <T>(product: CatalogIssue['product'], request: () => Promise<T>): Promise<T | undefined> => {
    try { return await request(); }
    catch (error) {
      signal?.throwIfAborted();
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      issues.push({ product, message: error instanceof Error ? error.message : 'Feed unavailable' });
      return undefined;
    }
  };
  const inCycle = <T extends { effectiveDate: string }>(manifest: T): T => {
    if (manifest.effectiveDate !== revision) throw new Error(`Feed revision does not match ${revision}`);
    return manifest;
  };
  const [charts, navigation, procedures, terrain] = await Promise.all([
    load('charts', async () => {
      const result = await fetchChartManifest(revisionRoot, revision, signal);
      inCycle(result.manifest);
      return result;
    }),
    load('navigation', async () => {
      const manifest = await fetchNavigationManifest(revision, signal);
      const products = new Map(manifest.products.map(product => [product.id, product]));
      for (const id of [...NAVIGATION.map(layer => layer.id), 'airways']) requiredProduct(products, id);
      return manifest;
    }),
    load('procedures', async () => inCycle(await fetchDocument(
      `${revisionRoot}/tpp/manifest.json`,
      isProcedureManifest,
      'FAA procedure manifest',
      revision,
      signal,
    ))),
    load('terrain', async () => {
      try { return await fetchJson(`${chartRoot()}/terrain/manifest.json`, isTerrainManifest,
        'Terrain manifest', { revalidate: true, ...(signal ? { signal } : {}) }); }
      catch (error) {
        if (error instanceof JsonResponseError && [404, 410].includes(error.status)) return undefined;
        throw error;
      }
    }),
  ]);
  signal?.throwIfAborted();
  const chartManifest = charts?.manifest;

  // Same-cycle rebuilds can add reference fields. Give each export its own cache key.
  const navigationVersion = encodeURIComponent(navigation?.generatedAt ?? '');
  const products = new Map(navigation?.products.map((product) => [product.id, product]));
  const navigationLayers = navigation ? NAVIGATION.map(definition => navigationLayer(revision, navigation, definition)) : [];
  const airways = products.get('airways');
  const preferredRoutes = products.get('preferred-routes');
  const terminal = products.get('terminal-procedures');
  const history = products.get('route-history');
  let routeHistory: RouteHistoryResource | undefined;
  if (history) {
    const candidate = { ...history, title: 'Historical filed routes',
      url: `${revisionRoot}/nav/${history.file}?v=${navigationVersion}` };
    if (isRouteHistoryResource(candidate)) routeHistory = candidate;
    else issues.push({ product: 'route-history', message: 'Route history metadata is invalid' });
  }

  return {
    schemaVersion: 1,
    issues: issues.sort((a, b) => a.product.localeCompare(b.product)),
    generatedAt: newestTimestamp([
      chartManifest?.generatedAt,
      navigation?.generatedAt,
      procedures?.generatedAt,
    ].filter((value): value is string => value !== undefined)),
    revision,
    ...(terrain ? { terrain: { ...terrain, root: `${chartRoot()}/terrain` } } : {}),
    charts: (chartManifest?.charts ?? []).map((chart): ChartRecord => ({
      id: chart.id,
      title: chart.title,
      kind: chart.kind,
      revision,
      format: 'mbtiles',
      bounds: chart.bounds,
      minZoom: chart.minZoom,
      maxZoom: chart.maxZoom,
      byteLength: chart.byteLength,
      sha256: chart.sha256,
      url: `${charts!.root}/${chart.file}?sha256=${chart.sha256}&bytes=${chart.byteLength}`,
    })),
    ...(chartManifest?.schemaVersion === 2 ? {
      chartPackages: {
        root: charts!.packageRoot!,
        maximumArchiveBytes: chartManifest.maximumArchiveBytes,
        archives: chartManifest.archives,
        regions: chartManifest.regions,
      },
    } : {}),
    navigation: navigationLayers,
    ...(airways ? { airways: {
      id: 'airways',
      title: 'Victor and Tango airways',
      count: airways.count,
      sourceCount: airways.count,
      url: `${revisionRoot}/nav/${airways.file}?v=${navigationVersion}`,
    } } : {}),
    ...(procedures ? { procedures: {
      id: 'procedures',
      title: 'Airport procedures',
      cycle: procedures.cycle,
      effectiveDate: procedures.effectiveDate,
      expirationDate: procedures.expirationDate,
      airportCount: procedures.airportCount,
      sourceAirportCount: procedures.airportCount,
      procedureCount: procedures.procedureCount,
      sourceProcedureCount: procedures.procedureCount,
      url: `${revisionRoot}/tpp/catalog.json?v=${encodeURIComponent(procedures.generatedAt)}`,
    } } : {}),
    ...(preferredRoutes ? { preferredRoutes: {
      id: 'preferred-routes',
      title: 'FAA preferred and TEC routes',
      count: preferredRoutes.count,
      sourceCount: preferredRoutes.count,
      url: `${revisionRoot}/nav/${preferredRoutes.file}?v=${navigationVersion}`,
    } } : {}),
    ...(routeHistory ? { routeHistory } : {}),
    ...(terminal ? { terminalProcedures: {
      id: 'terminal-procedures', title: 'FAA terminal procedure routes',
      count: terminal.count, sourceCount: terminal.count,
      url: `${revisionRoot}/nav/${terminal.file}?v=${navigationVersion}`,
    } } : {}),
    weather: [
      { id: 'awc.metar', title: 'METAR flight categories', status: 'current' },
      { id: 'awc.pirep', title: 'PIREPs', status: 'planned' },
      { id: 'awc.sigmet', title: 'SIGMETs', status: 'planned' },
    ],
  };
}

async function fetchChartManifest(
  revisionRoot: string,
  revision: string,
  signal?: AbortSignal,
): Promise<{ manifest: ChartManifest; root: string; packageRoot?: string }> {
  const root = `${revisionRoot}/mbtiles`;
  for (const packageRoot of [root, `${root}/packages`]) {
    try {
      const manifest = await fetchDocument(
        `${packageRoot}/manifest.json`,
        (value): value is ChartManifest => isChartManifest(value) && value.schemaVersion === 2,
        'FAA chart package manifest', revision, signal,
      );
      return { manifest, root, packageRoot };
    } catch (error) {
      if (!isMissingManifest(error)) throw error;
    }
  }
  try {
    const manifest = await fetchDocument(
      `${root}/chart-manifest.json`,
      (value): value is ChartManifest => isChartManifest(value) && value.schemaVersion === 1,
      'FAA chart manifest', revision, signal,
    );
    return { manifest, root };
  } catch (error) {
    // Legacy hosts omit CORS headers on 404s, which browsers report as TypeError.
    // Also permits an offline client to use its previously cached flat manifest.
    // A malformed response, readable server error, or cancellation is not absence.
    if (!isMissingManifest(error)) throw error;
    const manifest = await fetchDocument(
      `${revisionRoot}/chart-manifest.json`,
      (value): value is ChartManifest => isChartManifest(value) && value.schemaVersion === 1,
      'FAA chart manifest', revision, signal,
    );
    return { manifest, root: revisionRoot };
  }
}

function isMissingManifest(error: unknown): boolean {
  return error instanceof TypeError ||
    (error instanceof JsonResponseError && [404, 410].includes(error.status));
}

async function fetchDocument<T>(
  url: string,
  guard: (value: unknown) => value is T,
  label: string,
  revision: string,
  signal?: AbortSignal,
): Promise<T> {
  // A manual upload can expand the same FAA cycle; retain only a validated fallback.
  return fetchJson(url, (value): value is T => guard(value) &&
    isRecord(value) && value.effectiveDate === revision, label,
    { revalidate: true, ...(signal ? { signal } : {}) });
}

function requiredProduct(
  products: ReadonlyMap<string, NavigationProduct>,
  id: string,
): NavigationProduct {
  const product = products.get(id);
  if (!product) throw new Error(`FAA navigation manifest is missing ${id}`);
  return product;
}

function isNavigationManifest(value: unknown): value is NavigationManifest {
  return isRecord(value) && value.schemaVersion === 1 &&
    isIsoDate(value.effectiveDate) && isTimestamp(value.generatedAt) &&
    Array.isArray(value.products) && value.products.every((product) =>
      isRecord(product) && isNonEmptyString(product.id) &&
      isSafeFilename(product.file) && isCount(product.count)
    ) && hasUniqueStrings(value.products.map((product) => product.id));
}

function isChartManifest(value: unknown): value is ChartManifest {
  return isRecord(value) && (value.schemaVersion === 1 || value.schemaVersion === 2) &&
    isIsoDate(value.effectiveDate) && isTimestamp(value.generatedAt) &&
    Array.isArray(value.charts) && value.charts.length > 0 &&
    value.charts.every(isPublishedChart) &&
    hasUniqueStrings(value.charts.map((chart) => chart.id)) &&
    hasUniqueStrings(value.charts.map((chart) => chart.file)) &&
    (value.schemaVersion === 1 || (value.packagingVersion === 1 && isChartPackageIndex(value)));
}

function isPublishedChart(value: unknown): value is PublishedChart {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.id) && isNonEmptyString(value.title) &&
    typeof value.kind === 'string' &&
    PUBLISHED_CHART_KINDS.has(value.kind as Exclude<ChartKind, 'unknown'>) &&
    isSafeFilename(value.file) && value.file === `${value.id}.mbtiles` &&
    isBounds(value.bounds) && isCount(value.minZoom) && isCount(value.maxZoom) &&
    value.maxZoom <= 24 && value.minZoom <= value.maxZoom &&
    isCount(value.byteLength) && value.byteLength > 0 &&
    typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256) &&
    isNonEmptyString(value.cutlineProvenance);
}

function isProcedureManifest(value: unknown): value is ProcedureManifest {
  return isRecord(value) && value.schemaVersion === 1 &&
    typeof value.cycle === 'string' && /^\d{4}$/.test(value.cycle) &&
    isIsoDate(value.effectiveDate) && isIsoDate(value.expirationDate) &&
    isTimestamp(value.generatedAt) &&
    value.effectiveDate < value.expirationDate &&
    isCount(value.airportCount) && isCount(value.procedureCount);
}

function newestTimestamp(values: readonly string[]): string {
  return values.length ? values.reduce((newest, value) =>
    Date.parse(value) > Date.parse(newest) ? value : newest
  ) : new Date().toISOString();
}

function isSafeFilename(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]*$/i.test(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

/** Uses the same validated, durable JSON cache as the other chart reference data. */
export async function fetchMagneticModel(revision: string, signal?: AbortSignal): Promise<MagneticModel> {
  const resource = await fetchMagneticModelResource(revision, signal);
  return fetchJson(resource.url, (value): value is MagneticModel => isMagneticModel(value) &&
    value.effectiveDate === revision && value.coefficients.length === resource.count,
  'Geographic magnetic model', signal ? { signal } : {});
}
