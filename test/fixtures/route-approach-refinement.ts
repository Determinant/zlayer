import { isTerminalProceduresData, type TerminalProceduresData } from '@zlayer/contracts';
import approaches from '../../packages/domain/test/fixtures/approach-joining.json' with { type: 'json' };
import matching from '../../packages/domain/test/fixtures/approach-matching.json' with { type: 'json' };
import captures from '../../packages/domain/test/fixtures/approach-course-capture.json' with { type: 'json' };
import maneuvers from '../../packages/domain/test/fixtures/approach-maneuvers.json' with { type: 'json' };
import associations from '../../packages/domain/test/fixtures/approach-associations.json' with { type: 'json' };
import charts from './route-approaches.json' with { type: 'json' };
import { jsonIdentity } from '../../src/core/data/json-identity';
import type { ApproachAssociations, ProcedureCatalog } from '@zlayer/contracts';

export function refinementTerminal(id: string): TerminalProceduresData {
  const data: unknown = { type: 'ZLayerTerminalProcedures', metadata: {
    effectiveDate: '2026-09-03', source: 'FAA CIFP 2609',
  }, procedures: [], approaches: { ...approaches, procedures: [...approaches.procedures, ...matching.procedures, ...captures.procedures, ...maneuvers.procedures]
    .filter(p => p.id === id || id === 'KBJC' && p.airport === id) } };
  if (!isTerminalProceduresData(data) || data.approaches!.procedures.length !== (id === 'KBJC' ? 2 : 1)) throw new Error('Invalid refinement fixture');
  return data;
}

/** A real publisher-reviewed record carried in the small browser catalog. */
export function refinementPublishedCatalog(id: string, title: string): ProcedureCatalog | undefined {
  const record = associations.records.find(r => r.rule === 'reviewed' && r.title === title && r.routeIds.includes(id));
  if (!record) return;
  const terminal = refinementTerminal(id), p = terminal.approaches!.procedures[0]!, template = charts.airports[0]!;
  return { ...charts, airports: [{ ...template, id: p.airport, faaId: p.airport.slice(1), icaoId: p.airport,
    procedures: [{ ...template.procedures.find(p => p.id === 'ils')!, name: title }] }],
    associations: { ...associations, records: [{ ...record, procedureId: 'ils' }], sources: { ...associations.sources,
      terminalJsonSha256: jsonIdentity(terminal), chartXmlSha256: charts.sourceXml.sha256 } } as ApproachAssociations } as ProcedureCatalog;
}
