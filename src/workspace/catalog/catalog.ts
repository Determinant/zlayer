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
import { fetchGlideSource } from '../../layers/glide/data';
import { chartRoot } from './feed';
import { isTerrainManifest, isNavigationManifest, isSha256, type NavigationManifest, type NavigationProduct } from '@zlayer/contracts';
import { matchesJsonIdentity } from '../../core/data/references';
import { fetchChartCycles, isSupportedCycle } from './cycles';
import { chartEditionCoversCycle, faaEffectiveDate } from '@zlayer/contracts';
import { fetchJson } from '../../core/data/fetch-json';
import { JsonResponseError } from '../../core/data/errors';
import { isRecord, isNonEmptyString, isNonNegativeInteger as isCount, isIsoDate,
  isStrictBounds as isBounds, hasUniqueStrings } from '@zlayer/contracts';

export type CatalogIssue = { product: 'charts' | 'navigation' | 'procedures' | 'route-history' | 'terrain' | 'glide'; message: string };
export type ChartCatalog = CatalogResponse & { issues: CatalogIssue[] };

const PUBLISHED_CHART_KINDS = new Set<Exclude<ChartKind, 'unknown'>>([
  'vfr-sectional',
  'vfr-terminal',
  'vfr-flyway',
  'ifr-low',
  'ifr-high',
]);

type ProcedureManifest = {
  associationStatus?: 'available' | 'unavailable';
  schemaVersion: 1 | 2;
  file?: string; jsonSha256?: string;
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

async function fetchNavigationManifest(revision: string, signal?: AbortSignal, requireFresh = false): Promise<NavigationManifest> {
  return fetchDocument(`${chartRoot()}/${revision}/nav/manifest.json`, isNavigationManifest,
    'FAA navigation manifest', revision, signal, undefined, requireFresh);
}

/** Optional geographic model; discovery uses the selected cycle and configured feed. */
export async function fetchMagneticModelResource(revision: string, signal?: AbortSignal) {
  if (!isSupportedCycle(revision)) throw new Error(`Unsupported FAA cycle: ${revision}`);
  const manifest = await fetchNavigationManifest(revision, signal);
  const product = requiredProduct(new Map(manifest.products.map(item => [item.id, item])), 'magnetic-model');
  return { count: product.count, ...jsonIdentityFields(product),
    url: `${chartRoot()}/${revision}/nav/${product.file}${manifest.schemaVersion >= 2 ? '' : `?v=${encodeURIComponent(manifest.generatedAt)}`}` };
}

function navigationLayer(revision: string, manifest: NavigationManifest,
  definition: NavigationDefinition): NavigationLayerRecord {
  const product = requiredProduct(new Map(manifest.products.map(product => [product.id, product])),
    manifest.schemaVersion === 3 && definition.id === 'vfr-waypoints' ? 'fixes' : definition.id);
  const count = manifest.schemaVersion === 3 && (definition.id === 'fixes' || definition.id === 'vfr-waypoints')
    ? definition.id === 'fixes' ? product.count - product.vfrWaypointCount! : product.vfrWaypointCount!
    : product.count;
  return { ...definition, count, sourceCount: product.count, ...jsonIdentityFields(product),
    ...(manifest.schemaVersion === 3 && definition.id === 'vfr-waypoints' ? { subset: 'vfr-waypoints' as const } : {}),
    ...(manifest.schemaVersion === 3 && definition.id === 'fixes' ? { subset: 'other-fixes' as const } : {}),
    url: `${chartRoot()}/${revision}/nav/${product.file}${manifest.schemaVersion >= 2 ? '' : `?v=${encodeURIComponent(manifest.generatedAt)}`}` };
}

export function isInsideChartCoverage(
  [longitude, latitude]: [number, number],
  charts: readonly Pick<ChartRecord, 'bounds'>[],
): boolean {
  return charts.some(({ bounds: [west, south, east, north] }) =>
    longitude >= west && longitude <= east && latitude >= south && latitude <= north
  );
}

/** Offline updates explicitly discover the latest effective, usable publication.
 * A stale discovery list cannot authorize a claim that a selection is up to date.
 */
export async function fetchLatestDownloadCatalog(signal?: AbortSignal): Promise<ChartCatalog> {
  const { revisions, stale } = await fetchChartCycles(signal);
  if (stale) throw new Error('Could not check the latest FAA cycle. Reconnect and try again; saved downloads are kept.');
  for (const revision of revisions.filter(revision => revision <= faaEffectiveDate())) {
    const catalog = await fetchChartCatalog(revision, signal, revisions, { requireFresh: true });
    if (catalog.issues.length) throw new Error(`FAA ${revision} download metadata is unavailable: ${catalog.issues.map(issue => issue.message).join(' ')}`);
    if (catalog.charts.length) return catalog;
  }
  throw new Error('No effective FAA cycle is ready for download. Saved downloads are kept.');
}

export async function fetchChartCatalog(revision: string, signal?: AbortSignal,
  publishedRevisions?: readonly string[], options: { requireFresh?: boolean } = {}): Promise<ChartCatalog> {
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
  const navigationRequest = load('navigation', async () => {
    const manifest = await fetchNavigationManifest(revision, signal, options.requireFresh);
    const products = new Map(manifest.products.map(product => [product.id, product]));
    for (const id of [...NAVIGATION.filter(layer => manifest.schemaVersion !== 3 || layer.id !== 'vfr-waypoints')
      .map(layer => layer.id), 'airways']) requiredProduct(products, id);
    return manifest;
  });
  const procedureRequest = load('procedures', async () => inCycle(await fetchDocument(
    `${revisionRoot}/tpp/manifest.json`, isProcedureManifest, 'FAA procedure manifest', revision, signal, undefined, options.requireFresh,
  )));
  const [charts, navigation, procedures, terrain, glide] = await Promise.all([
    load('charts', async () => {
      try { return await fetchChartManifest(revisionRoot, revision, signal, options.requireFresh); }
      catch (error) {
        signal?.throwIfAborted();
        // Carryover is only for absent raster publications with complete current
        // navigation and TPP metadata. Invalid manifests and server errors stay visible.
        if (!isMissingManifest(error)) throw error;
        const [navigation, procedures] = await Promise.all([navigationRequest, procedureRequest]);
        if (!navigation || !procedures) throw error;
        const published = publishedRevisions ?? (await fetchChartCycles(signal)).revisions;
        const candidates = [...new Set(published)].filter(date => isSupportedCycle(date) &&
          date < revision && chartEditionCoversCycle(date, revision)).sort().reverse();
        for (const date of candidates) {
          signal?.throwIfAborted();
          try { return await fetchChartManifest(`${chartRoot()}/${date}`, date, signal, options.requireFresh); }
          catch (error) { if (!isMissingManifest(error)) throw error; }
        }
        throw error;
      }
    }),
    navigationRequest,
    procedureRequest,
    load('terrain', async () => {
      try { return await fetchJson(`${chartRoot()}/terrain/manifest.json`, isTerrainManifest,
        'Terrain manifest', { policy: options.requireFresh ? 'network-only' : 'network-first', ...(signal ? { signal } : {}) }); }
      catch (error) {
        if (error instanceof JsonResponseError && [404, 410].includes(error.status)) return undefined;
        throw error;
      }
    }),
    load('glide', () => fetchGlideSource(`${chartRoot()}/glide`, signal, options.requireFresh)),
  ]);
  signal?.throwIfAborted();
  const chartManifest = charts?.manifest;

  // Immutable filenames already identify the bytes. Legacy paths still need a build key.
  const navigationVersion = navigation && navigation.schemaVersion >= 2 ? '' : `?v=${encodeURIComponent(navigation?.generatedAt ?? '')}`;
  const products = new Map(navigation?.products.map((product) => [product.id, product]));
  const navigationLayers = navigation ? NAVIGATION.map(definition => navigationLayer(revision, navigation, definition)) : [];
  const airways = products.get('airways');
  const preferredRoutes = products.get('preferred-routes');
  const terminal = products.get('terminal-procedures');
  const history = products.get('route-history');
  let routeHistory: RouteHistoryResource | undefined;
  if (history) {
    const candidate = { ...history, title: 'Historical filed routes',
      url: `${revisionRoot}/nav/${history.file}${navigationVersion}` };
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
    ...(glide ? { glide } : {}),
    ...(terrain ? { terrain: { ...terrain, root: `${chartRoot()}/terrain` } } : {}),
    charts: (chartManifest?.charts ?? []).map((chart): ChartRecord => ({
      id: chart.id,
      title: chart.title,
      kind: chart.kind,
      revision: chartManifest!.effectiveDate,
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
      ...jsonIdentityFields(airways),
      url: `${revisionRoot}/nav/${airways.file}${navigationVersion}`,
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
      ...jsonIdentityFields(procedures),
      ...(procedures.associationStatus ? { associationStatus: procedures.associationStatus } : {}),
      url: `${revisionRoot}/tpp/${procedures.file ?? 'catalog.json'}${procedures.schemaVersion === 2 ? '' : `?v=${encodeURIComponent(procedures.generatedAt)}`}`,
    } } : {}),
    ...(preferredRoutes ? { preferredRoutes: {
      id: 'preferred-routes',
      title: 'FAA preferred and TEC routes',
      count: preferredRoutes.count,
      sourceCount: preferredRoutes.count,
      ...jsonIdentityFields(preferredRoutes),
      url: `${revisionRoot}/nav/${preferredRoutes.file}${navigationVersion}`,
    } } : {}),
    ...(routeHistory ? { routeHistory } : {}),
    ...(terminal ? { terminalProcedures: {
      id: 'terminal-procedures', title: 'FAA terminal procedure routes',
      count: terminal.count, sourceCount: terminal.count,
      ...jsonIdentityFields(terminal),
      ...(navigation && navigation.schemaVersion >= 2 ? { schemaVersion: 2 as const, coverage: terminal.coverage! } : {}),
      url: `${revisionRoot}/nav/${terminal.file}${navigationVersion}`,
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
  requireFresh = false,
): Promise<{ manifest: ChartManifest; root: string; packageRoot?: string }> {
  const root = `${revisionRoot}/mbtiles`;
  for (const packageRoot of [root, `${root}/packages`]) {
    try {
      const manifest = await fetchDocument(
        `${packageRoot}/manifest.json`,
        (value): value is ChartManifest => isChartManifest(value) && value.schemaVersion === 2,
        'FAA chart package manifest', revision, signal, supportedChartFamilies, requireFresh,
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
      'FAA chart manifest', revision, signal, supportedChartFamilies, requireFresh,
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
      'FAA chart manifest', revision, signal, supportedChartFamilies, requireFresh,
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
  normalize?: (value: unknown) => unknown,
  requireFresh = false,
): Promise<T> {
  // A manual upload can expand the same FAA cycle; retain only a validated fallback.
  return fetchJson(url, (value): value is T => guard(value) &&
    isRecord(value) && value.effectiveDate === revision, label,
    { policy: requireFresh ? 'network-only' : 'network-first', ...(signal ? { signal } : {}), ...(normalize ? { normalize } : {}) });
}

/** An added chart family must not invalidate products this client understands.
 * Remove only explicitly unsupported families and references to their archives;
 * malformed supported records and dangling region dependencies still fail validation. */
function supportedChartFamilies(value: unknown): unknown {
  const hasKind = (item: unknown): item is Record<string, unknown> & { kind: string } =>
    isRecord(item) && isNonEmptyString(item.kind);
  const supported = (item: { kind: string }) => PUBLISHED_CHART_KINDS.has(item.kind as Exclude<ChartKind, 'unknown'>);
  if (!isRecord(value) || !Array.isArray(value.charts) || !value.charts.every(hasKind)) return value;
  const charts = value.charts.filter(supported);
  if (value.schemaVersion === 1) return { ...value, charts };
  if (value.schemaVersion !== 2 || !Array.isArray(value.archives) || !value.archives.every(hasKind) ||
      !value.archives.every(item => isNonEmptyString(item.id)) ||
      !hasUniqueStrings(value.archives.map(item => item.id as string)) || !Array.isArray(value.regions)) return value;
  const excluded = new Set(value.archives.filter(item => !supported(item)).map(item => item.id));
  const regions = value.regions.map((region: unknown) => {
    if (!isRecord(region) || !Array.isArray(region.archiveIds) ||
        !region.archiveIds.every(isNonEmptyString) || !hasUniqueStrings(region.archiveIds)) return region;
    return { ...region, archiveIds: region.archiveIds.filter(id => !excluded.has(id)) };
  });
  return { ...value, charts, archives: value.archives.filter(supported), regions };
}

function requiredProduct(
  products: ReadonlyMap<string, NavigationProduct>,
  id: string,
): NavigationProduct {
  const product = products.get(id);
  if (!product) throw new Error(`FAA navigation manifest is missing ${id}`);
  return product;
}

function jsonIdentityFields(value: { jsonSha256?: string }) {
  return value.jsonSha256 ? { jsonSha256: value.jsonSha256 } : {};
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
  return isRecord(value) && (value.schemaVersion === 1 || value.schemaVersion === 2) &&
    typeof value.cycle === 'string' && /^\d{4}$/.test(value.cycle) &&
    isIsoDate(value.effectiveDate) && isIsoDate(value.expirationDate) &&
    isTimestamp(value.generatedAt) &&
    value.effectiveDate < value.expirationDate &&
    isCount(value.airportCount) && isCount(value.procedureCount) &&
    (value.schemaVersion === 1 || (value.associationStatus === 'available' || value.associationStatus === 'unavailable') && isSafeFilename(value.file) && isSha256(value.jsonSha256) &&
      isSha256(value.sha256) && value.file.includes(`.${value.sha256}.`));
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
    value.effectiveDate === revision && value.coefficients.length === resource.count && matchesJsonIdentity(resource, value),
  'Geographic magnetic model', signal ? { signal } : {});
}
