import type { ChartSupplementCatalog, GeoPointFeature, ProcedureCatalog } from '@zlayer/contracts';
import { findProcedureAirport, groupProcedures, procedureSelection, type ProcedureSelection } from './data';
import { supplementSelections } from './supplements';

type PlateRow = { selection: ProcedureSelection; detail: string };
export type PlateGroup = { id: string; title: string; plates: PlateRow[] };

export function airportPlateGroups(
  feature: GeoPointFeature,
  procedures: { catalog: ProcedureCatalog; url: string } | undefined,
  supplements: { catalog: ChartSupplementCatalog; url: string } | undefined,
  baseUrl: string,
): PlateGroup[] {
  const airport = procedures && findProcedureAirport(procedures.catalog, feature);
  const groups: PlateGroup[] = airport && procedures ? groupProcedures(airport).map(group => ({
    id: group.kind, title: group.title,
    plates: group.procedures.map(procedure => ({
      selection: procedureSelection(procedures.catalog, airport, procedure, procedures.url, baseUrl),
      detail: [procedure.source.chartCode,
        procedure.source.amendmentNumber && `Amdt ${procedure.source.amendmentNumber}`,
        procedure.source.userAction === 'C' && 'Changed', procedure.source.userAction === 'A' && 'Added',
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
