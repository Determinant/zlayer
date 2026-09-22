import { bookUrl } from '@zlayer/contracts';
import { featureIdentifiers } from '@zlayer/domain';
import type {
  GeoPointFeature,
  ProcedureAirport,
  ProcedureCatalog,
  ProcedureKind,
  ProcedureRecord,
  ChartSupplementVolume,
} from '@zlayer/contracts';

export type ProcedureGroup = {
  kind: ProcedureKind;
  title: string;
  procedures: ProcedureRecord[];
};

export type ProcedureDocument = {
  url: string;
  nativeUrl: string;
  pageIndex: number;
  namedDestination?: string;
  pageCount?: number;
  byteLength?: number;
  sha256?: string;
  source: 'combined-volume' | 'faa-individual' | 'chart-supplement';
};

export type ProcedureSelection = {
  airport: Pick<ProcedureAirport, 'id'>;
  procedure: Pick<ProcedureRecord, 'id' | 'name'> & Partial<Pick<ProcedureRecord, 'kind'>>;
  document: ProcedureDocument;
  cycle: string;
  effectiveDate: string;
  expirationDate: string;
};

const GROUPS: Array<[ProcedureKind, string]> = [
  ['airport-diagram', 'Airport'],
  ['approach', 'Approaches'],
  ['departure', 'Departures'],
  ['arrival', 'Arrivals'],
  ['takeoff-minimums', 'Takeoff minima and ODPs'],
  ['diverse-vector-area', 'Diverse vector areas'],
  ['alternate-minimums', 'Alternate minima'],
  ['radar-minimums', 'Radar minima'],
  ['hot-spot', 'Hot spots'],
  ['lahso', 'LAHSO'],
  ['other', 'Other'],
];

/** Keep plates available for explicitly typed airports and legacy FAA-ID records. */
export function hasAirportPlates(feature: GeoPointFeature): boolean {
  return feature.properties.kind === 'airport' || Boolean(feature.properties.faaId);
}

export function findProcedureAirport(
  catalog: ProcedureCatalog,
  feature: GeoPointFeature,
): ProcedureAirport | undefined {
  const identifiers = new Set(featureIdentifiers(feature));
  return catalog.airports.find((airport) =>
    identifiers.has(airport.id) ||
    identifiers.has(airport.faaId) ||
    (airport.icaoId !== null && identifiers.has(airport.icaoId))
  );
}

export function groupProcedures(airport: ProcedureAirport): ProcedureGroup[] {
  const available = airport.procedures.filter(
    (procedure) => procedure.source.userAction !== 'D',
  );
  return GROUPS.flatMap(([kind, title]) => {
    const procedures = available.filter((procedure) => procedure.kind === kind);
    return procedures.length > 0 ? [{ kind, title, procedures }] : [];
  });
}

/** Readers and route pickers share document targeting and edition identity. */
export function procedureSelection(catalog: ProcedureCatalog, airport: ProcedureAirport,
  procedure: ProcedureRecord, catalogUrl: string, baseUrl: string): ProcedureSelection {
  return { airport, procedure, document: procedureDocument(catalog, procedure, catalogUrl, baseUrl),
    cycle: catalog.cycle, effectiveDate: catalog.effectiveDate, expirationDate: catalog.expirationDate };
}

export function procedureDocument(
  catalog: ProcedureCatalog,
  procedure: ProcedureRecord,
  catalogUrl: string,
  baseUrl: string,
): ProcedureDocument {
  const target = procedure.volumeTarget;
  const volume = target?.pageIndex !== null && target?.pageIndex !== undefined
    ? catalog.volumes.find((candidate) => candidate.id === target.volumeId)
    : undefined;
  if (target && target.pageIndex !== null && volume) {
    return bookDocument(volume, target.pageIndex, catalogUrl, baseUrl);
  }

  const faaPdfBaseUrl = new URL(catalog.faaPdfBaseUrl, baseUrl);
  const address = new URL(procedure.pdfUrl, faaPdfBaseUrl);
  const originalUrl = address.href;
  address.searchParams.set('v', catalog.generatedAt);
  const destination = procedure.namedDestination
    ? `nameddest=${encodeURIComponent(procedure.namedDestination)}`
    : 'page=1';
  return {
    url: address.href,
    nativeUrl: withPdfTarget(originalUrl, destination),
    pageIndex: 0,
    ...(procedure.namedDestination ? { namedDestination: procedure.namedDestination } : {}),
    source: 'faa-individual',
  };
}

export function bookDocument(
  volume: ChartSupplementVolume,
  pageIndex: number,
  catalogUrl: string,
  baseUrl: string,
): ProcedureDocument {
  const url = bookUrl(volume, new URL(catalogUrl, baseUrl).href);
  return {
    url, nativeUrl: withPdfTarget(url, `page=${pageIndex + 1}`), pageIndex,
    pageCount: volume.pageCount, byteLength: volume.byteLength, sha256: volume.sha256,
    source: 'combined-volume',
  };
}

function withPdfTarget(url: string, target: string): string {
  return `${url.split('#', 1)[0]}#${target}`;
}
