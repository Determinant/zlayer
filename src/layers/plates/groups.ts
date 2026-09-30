import type { ChartSupplementCatalog, GeoPointFeature, ProcedureCatalog, ProcedureRecord } from '@zlayer/contracts';
import { findProcedureAirport, groupProcedures, procedureSelection, type ProcedureSelection } from './data';
import { supplementSelections } from './supplements';

type PlateRow = { selection: ProcedureSelection; detail: string };
export type PlateGroup = { id: string; title: string; plates: PlateRow[] };

/** A continuation is reachable with Next page only when the published book has every preceding page. */
function listedProcedures(procedures: ProcedureRecord[]): Array<{ procedure: ProcedureRecord; pages: number }> {
  const byName = new Map(procedures.map(procedure => [procedure.name, procedure]));
  const hidden = new Set<string>();
  const pageCounts = new Map<string, number>();
  for (const procedure of procedures) {
    const continuation = /^(.*), CONT\.(\d+)$/i.exec(procedure.name);
    if (!continuation) continue;
    const base = byName.get(continuation[1]!);
    const part = Number(continuation[2]);
    const target = base?.volumeTarget;
    if (!base || !base.source.procedureId || base.source.procedureId !== procedure.source.procedureId ||
      !target || target.pageIndex === null || !Number.isSafeInteger(part) || part < 1 || part >= procedures.length) continue;
    const complete = Array.from({ length: part }, (_, index) => {
      const page = byName.get(`${base.name}, CONT.${index + 1}`);
      return page?.source.procedureId === base.source.procedureId &&
        page.volumeTarget?.volumeId === target.volumeId && page.volumeTarget.pageIndex === target.pageIndex! + index + 1;
    }).every(Boolean);
    if (!complete) continue;
    hidden.add(procedure.id);
    pageCounts.set(base.id, (pageCounts.get(base.id) ?? 1) + 1);
  }
  return procedures.filter(procedure => !hidden.has(procedure.id))
    .map(procedure => ({ procedure, pages: pageCounts.get(procedure.id) ?? 1 }));
}

export function airportPlateGroups(
  feature: GeoPointFeature,
  procedures: { catalog: ProcedureCatalog; url: string } | undefined,
  supplements: { catalog: ChartSupplementCatalog; url: string } | undefined,
  baseUrl: string,
): PlateGroup[] {
  const airport = procedures && findProcedureAirport(procedures.catalog, feature);
  const groups: PlateGroup[] = airport && procedures ? groupProcedures(airport).map(group => ({
    id: group.kind, title: group.title,
    plates: listedProcedures(group.procedures).map(({ procedure, pages }) => ({
      selection: procedureSelection(procedures.catalog, airport, procedure, procedures.url, baseUrl),
      detail: [procedure.source.chartCode,
        procedure.source.amendmentNumber && `Amdt ${procedure.source.amendmentNumber}`,
        procedure.source.userAction === 'C' && 'Changed', procedure.source.userAction === 'A' && 'Added',
        pages > 1 && `${pages} pages`,
      ].filter(Boolean).join(' · '),
    })),
  })) : [];
  if (supplements) {
    const selections = supplementSelections(supplements.catalog, feature, supplements.url, baseUrl);
    if (selections.length) {
      let group = groups.find(group => group.id === 'airport-diagram');
      if (!group) { group = { id: 'airport-diagram', title: 'Airport', plates: [] }; groups.unshift(group); }
      group.plates.push(...selections.map(({ selection, volumeId, printedPage }) => ({ selection,
        detail: `CS ${volumeId} · Page ${printedPage}`,
      })));
    }
  }
  return groups;
}
