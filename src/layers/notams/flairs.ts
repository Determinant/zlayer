import type { NotamFact, NotamFlair, NotamInterpretationIssue, ParsedNotam } from './interpretation';

const bodyDetails = new Set<NotamFact['kind']>(['procedure', 'obstacle-marking', 'obstacle-lighting', 'lighting-note']);
const effects = new Set<NotamFact['kind']>(['closure', 'closure-restriction', 'outage', 'monitoring', 'restriction', 'activity']);

/** An at-a-glance body, independent of extraction and applicability. Keep distinct
 * amendments; remove repeated identities, never operational effects to meet a cap. */
export function notamFlairs(parsed: ParsedNotam): NotamFlair[] {
  const result: NotamFlair[] = [];
  const add = (fact: NotamFact, label = fact.label) => {
    const existing = result.find(item => item.label === label);
    if (existing) existing.evidence.push(fact.evidence);
    else result.push({ label, tone: fact.tone, evidence: [fact.evidence] });
  };
  const operational = parsed.facts.filter(fact => effects.has(fact.kind));
  const identity = parsed.facts.find(fact => fact.kind === 'runway' || fact.kind === 'taxiway');
  const subject = parsed.facts.find(fact => fact.kind === 'subject');
  const procedures = parsed.facts.filter(fact => fact.kind === 'procedure');
  const multiple = new Set(procedures.map(fact => fact.label.toUpperCase().replace(/\s+/g, ' '))).size > 1;
  if (multiple) {
    const label = parsed.subject === 'IAP' ? 'Multiple Approaches' : parsed.subject === 'STAR' ? 'Multiple Arrivals' : 'Multiple Departures';
    for (const fact of procedures) add(fact, label);
  } else if (parsed.procedureNotice && subject) add(subject);

  // Scope comes from the recognizer, not from joining nearby words in the UI.
  // In particular, the first taxiway in a compound closure does not own it all.
  for (const fact of operational) {
    const effect = fact.scope ? fact.label.replace(/^(?:Runway|Taxiway) /, '') : fact.label;
    add(fact, fact.scope ? `${fact.scope} · ${effect}`
      : fact.kind === 'closure' && parsed.subject === 'TWY' ? 'Taxiway Closure' : effect);
  }
  if (!operational.length && identity) add(identity);
  const detail = parsed.facts.some(fact => fact.kind === 'obstacle-kind');
  if (!parsed.procedureNotice && !operational.length && !identity && !detail && subject) add(subject);
  for (const fact of parsed.facts) {
    if (bodyDetails.has(fact.kind) || effects.has(fact.kind) || ['subject', 'runway', 'taxiway'].includes(fact.kind)) continue;
    add(fact);
  }
  return result;
}

const interpretationNotes: Partial<Record<NotamInterpretationIssue, { label: string; detail: string }>> = {
  'procedure-exceptions': { label: 'Check Procedure Exceptions', detail: 'This all-approach notice includes exclusions or conditions. Review them for the displayed procedure.' },
  'fact-limit': { label: 'Additional Wording Needs Review', detail: 'The notice exceeds the supported number of derived facts. The complete source remains in the body and raw disclosure.' },
  'body-limit': { label: 'Additional Wording Needs Review', detail: 'The notice exceeds the supported interpretation length. The complete source remains available.' },
};

export function notamInterpretationNotes(parsed: ParsedNotam): { label: string; detail: string }[] {
  const notes = new Map<string, string>();
  for (const issue of parsed.issues) {
    // Subject/title/dependency coverage belongs to the plate's matching status.
    // Individual notes describe a reading/operational limitation, not a parser state.
    const note = interpretationNotes[issue];
    if (!note) continue;
    const { label, detail } = note;
    notes.set(label, [notes.get(label), detail].filter(Boolean).join(' '));
  }
  return [...notes].map(([label, detail]) => ({ label, detail }));
}
