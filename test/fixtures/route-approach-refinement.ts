import { isTerminalProceduresData, type TerminalProceduresData } from '@zlayer/contracts';
import approaches from '../../packages/domain/test/fixtures/approach-joining.json' with { type: 'json' };
import matching from '../../packages/domain/test/fixtures/approach-matching.json' with { type: 'json' };

export function refinementTerminal(id: string): TerminalProceduresData {
  const data: unknown = { type: 'ZLayerTerminalProcedures', metadata: {
    effectiveDate: '2026-09-03', source: 'FAA CIFP 2609',
  }, procedures: [], approaches: { ...approaches, procedures: [...approaches.procedures, ...matching.procedures]
    .filter(p => p.id === id || id === 'KBJC' && p.airport === id) } };
  if (!isTerminalProceduresData(data) || data.approaches!.procedures.length !== (id === 'KBJC' ? 2 : 1)) throw new Error('Invalid refinement fixture');
  return data;
}
