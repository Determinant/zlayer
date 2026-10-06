/** Document interpretation states are independent of the UI and of plate matching.
 * Once a note or condition opens, punctuation cannot prove that its scope ended.
 * Multipart envelopes require separate assembly proof before structured values. */
export type NotamClauseState = 'operative' | 'instruction' | 'conditional' | 'multipart';
export type NotamClause = { source: string; start: number; end: number; state: NotamClauseState };
type Boundary = { state: Exclude<NotamClauseState, 'operative'>; start: number };

function boundary(source: string): Boundary | undefined {
  // These recognize control tokens, not the meaning of numbers or procedure names.
  const token = /\b(?:ADD|CHANGE|DELETE|DISREGARD|WHEN|UNLESS|EXC|EXCEPT|PROVIDED|NOTES?)\b|\bIF\b(?!\s*\))|\b(?:FOR INOP(?:ERATIVE)?|MISSED APPROACH):?|\bPART\s+\d+\s+OF\s+\d+\b/i.exec(source);
  if (!token) return;
  return { start: token.index, state: /^PART\b/i.test(token[0]) ? 'multipart'
    : /^(?:IF|WHEN|UNLESS|EXC|EXCEPT|PROVIDED|FOR INOP(?:ERATIVE)?)\b/i.test(token[0]) ? 'conditional' : 'instruction' };
}

/** Numeric effect badges use the same control boundaries as readable clauses. */
export function operativePrefix(source: string): string {
  const control = boundary(source);
  return control ? source.slice(0, control.start) : source;
}

const transitions: Record<NotamClauseState, Record<Boundary['state'], NotamClauseState>> = {
  operative: { instruction: 'instruction', conditional: 'conditional', multipart: 'multipart' },
  instruction: { instruction: 'instruction', conditional: 'instruction', multipart: 'multipart' },
  conditional: { instruction: 'conditional', conditional: 'conditional', multipart: 'multipart' },
  multipart: { instruction: 'multipart', conditional: 'multipart', multipart: 'multipart' },
};

/** Sentence lexer followed by a document state machine. Source positions address
 * the supplied text; whitespace inside a clause remains available to its grammar. */
export function notamClauses(source: string, maxClauses: number): NotamClause[] | undefined {
  const result: NotamClause[] = [];
  let state: NotamClauseState = 'operative', start = 0;
  const consume = (end: number) => {
    const text = source.slice(start, end);
    if (!text) return;
    const control = boundary(text);
    result.push({ source: text, start, end, state: control?.state === 'multipart' ? 'multipart' : state });
    if (control) state = transitions[state][control.state];
  };
  // No boundary at a decimal, slash, comma, semicolon, or publisher line wrap.
  for (const separator of source.matchAll(/\n\s*\n|(?<=\.)\s+(?=[A-Z0-9*#])/g)) {
    consume(separator.index);
    if (result.length > maxClauses) return;
    start = separator.index + separator[0].length;
  }
  consume(source.length);
  return result.length <= maxClauses ? result : undefined;
}
