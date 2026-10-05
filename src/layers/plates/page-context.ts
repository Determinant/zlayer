import { bookUrl, isNotamAirportQuery, type NotamAirportQuery, type ProcedureAirport, type ProcedureCatalog, type ProcedureRecord } from '@zlayer/contracts';
import type { ProcedureSelection } from './data';

export type PlateNoticeContext = { key: string; status: 'resolved' | 'loading' | 'unavailable' | 'not-procedure';
  airport?: NotamAirportQuery; airportName?: string; procedure?: ProcedureRecord; cycle: string; effectiveDate: string; expirationDate: string };

export function procedureNoticeContext(selection: ProcedureSelection, airport: ProcedureAirport, procedure: ProcedureRecord,
  key = `${selection.catalog?.jsonSha256 ?? selection.catalog?.url}|${procedure.id}`): PlateNoticeContext {
  const query = { ...(airport.faaId ? { faaId: airport.faaId.trim().toUpperCase() } : {}),
    ...(airport.icaoId ? { icaoId: airport.icaoId.trim().toUpperCase() } : {}) };
  const context = { key, cycle: selection.cycle, effectiveDate: selection.effectiveDate, expirationDate: selection.expirationDate };
  if (!isNotamAirportQuery(query)) return { ...context, status: 'unavailable' };
  return { ...context, status: ['approach', 'departure', 'arrival'].includes(procedure.kind) ? 'resolved' : 'not-procedure',
    airport: query, airportName: airport.name, procedure };
}

/** Exact published targets only. Never extend a plate's identity over unindexed pages. */
export function resolvePlateNoticeContext(selection: ProcedureSelection, pageIndex: number, catalog?: ProcedureCatalog): PlateNoticeContext {
  const context: PlateNoticeContext = { key: `${selection.document.url}|${pageIndex}`, status: 'unavailable',
    cycle: selection.cycle, effectiveDate: selection.effectiveDate, expirationDate: selection.expirationDate };
  if (selection.document.source === 'chart-supplement') return { ...context, status: 'not-procedure' };
  if (!catalog || !selection.catalog || catalog.cycle !== selection.cycle || catalog.effectiveDate !== selection.effectiveDate ||
      catalog.expirationDate !== selection.expirationDate) return context;
  const matches: { airport: ProcedureAirport; procedure: ProcedureRecord }[] = [];
  if (selection.document.source === 'combined-volume') {
    const volume = catalog.volumes.find(v => bookUrl(v, selection.catalog!.url) === selection.document.url &&
      v.sha256 === selection.document.sha256 && v.pageCount === selection.document.pageCount);
    if (!volume) return context;
    for (const airport of catalog.airports) for (const procedure of airport.procedures) {
      if (procedure.source.userAction !== 'D' && procedure.volumeTarget?.volumeId === volume.id && procedure.volumeTarget.pageIndex === pageIndex) {
        matches.push({ airport, procedure });
      }
    }
  } else if (pageIndex === selection.document.pageIndex && !selection.document.namedDestination) {
    const airport = catalog.airports.find(a => a.id === selection.airport.id);
    const procedure = airport?.procedures.find(p => p.id === selection.procedure.id && p.source.userAction !== 'D');
    if (airport && procedure) {
      const original = new URL(procedure.pdfUrl, new URL(catalog.faaPdfBaseUrl, selection.catalog.url));
      original.searchParams.set('v', catalog.generatedAt);
      if (original.href === selection.document.url) matches.push({ airport, procedure });
    }
  }
  if (matches.length !== 1) return context;
  return procedureNoticeContext(selection, matches[0]!.airport, matches[0]!.procedure, context.key);
}
