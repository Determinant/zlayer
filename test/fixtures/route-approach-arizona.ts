import { isTerminalProceduresData, type TerminalProceduresData } from '@zlayer/contracts';
import approaches from '../../packages/domain/test/fixtures/approach-return.json' with { type: 'json' };

export function arizonaTerminal(missingIntercept = false): TerminalProceduresData {
  const data: unknown = { type: 'ZLayerTerminalProcedures', metadata: {
    effectiveDate: '2026-09-03', source: 'FAA CIFP 2609',
  }, procedures: [], approaches: structuredClone(approaches) };
  if (!isTerminalProceduresData(data)) throw new Error('Invalid Arizona approach fixture');
  if (missingIntercept) delete data.approaches!.procedures[0]!.final.find(l => l.path === 'VI')!.magneticCourse;
  return data;
}
