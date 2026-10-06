import type { ParsedNotam } from './interpretation';

/** Airport reading order uses supported effects, independently of D/FDC and flair colors. */
export function airportNotamPriority({ subject, facts, procedureNotice }: ParsedNotam): number {
  const closure = facts.some(fact => fact.kind === 'closure' || fact.kind === 'closure-restriction');
  if (closure && ['AD', 'RWY', 'TWY'].includes(subject ?? '')) return 0;
  if (subject === 'NAV' && facts.some(fact => fact.kind === 'outage')) return 1;
  if (closure || procedureNotice || facts.some(fact =>
    fact.kind === 'outage' || fact.kind === 'monitoring' || fact.kind === 'restriction')) return 2;
  return 3;
}
