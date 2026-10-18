import { notamParts, maskNotamParts } from './multipart';

/** Document interpretation states are independent of the UI and of plate matching.
 * Once a note or condition opens, punctuation cannot prove that its scope ended.
 * Multipart envelopes require separate assembly proof before structured values. */
export type NotamClauseState = 'operative' | 'instruction' | 'conditional' | 'multipart';
export type NotamClause = { source: string; start: number; end: number; state: NotamClauseState };
type Boundary = { state: Exclude<NotamClauseState, 'operative'>; start: number };
const controls = /\b(?:ADD|CHANGE|DELETE|DISREGARD|CANCEL(?:S|LED)?|WHEN|UNLESS|EXC|EXCEPT|EXCLUDING|PROVIDED|NOTES?)\b|\bIF\b(?!\s*\))|\b(?:FOR INOP(?:ERATIVE)?|MISSED APPROACH):?|\bPART\s+\d+\s+OF\s+\d+\b/gi;

function controlState(token: string): Boundary['state'] {
  return /^PART\b/i.test(token) ? 'multipart'
    : /^(?:IF|WHEN|UNLESS|EXC|EXCEPT|EXCLUDING|PROVIDED|FOR INOP(?:ERATIVE)?)\b/i.test(token) ? 'conditional' : 'instruction';
}

function boundary(source: string): Boundary | undefined {
  // These recognize control tokens, not the meaning of numbers or procedure names.
  const token = new RegExp(controls.source, 'i').exec(source);
  if (!token) return;
  return { start: token.index, state: controlState(token[0]) };
}

/** Numeric effect badges use the same control boundaries as readable clauses. */
export function operativePrefix(source: string): string {
  const control = boundary(source);
  return control ? source.slice(0, control.start) : source;
}

const transitions: Record<NotamClauseState, Record<Boundary['state'], NotamClauseState>> = {
  operative: { instruction: 'instruction', conditional: 'conditional', multipart: 'multipart' },
  instruction: { instruction: 'instruction', conditional: 'instruction', multipart: 'multipart' },
  conditional: { instruction: 'instruction', conditional: 'conditional', multipart: 'multipart' },
  multipart: { instruction: 'multipart', conditional: 'multipart', multipart: 'multipart' },
};

/** Exact control scopes for consumers whose grammar begins inside a sentence.
 * Unlike sentence clauses, the control token itself belongs to the new state.
 * All consumers share the same lexer/transitions; punctuation never resets scope. */
export function notamScopes(source: string): NotamClause[] | undefined {
  if (source.length > 64 * 1024) return;
  const result: NotamClause[] = [];
  let state: NotamClauseState = 'operative', start = 0;
  for (const token of source.matchAll(controls)) {
    if (token.index > start) result.push({ source: source.slice(start, token.index), start, end: token.index, state });
    state = transitions[state][controlState(token[0])]; start = token.index;
    if (result.length > 128) return;
  }
  if (start < source.length) result.push({ source: source.slice(start), start, end: source.length, state });
  return result;
}

/** Sentence lexer followed by a document state machine. Source positions address
 * the supplied text; whitespace inside a clause remains available to its grammar. */
export function notamClauses(source: string, maxClauses: number): NotamClause[] | undefined {
  const result: NotamClause[] = [];
  const parts = notamParts(source), masked = parts ? maskNotamParts(source, parts) : source;
  const markers = parts?.flatMap(part => [part.opening, part.closing].filter(p => p !== undefined)) ?? [];
  let state: NotamClauseState = 'operative', start = 0;
  const consume = (end: number) => {
    const text = source.slice(start, end);
    if (!text.trim()) return;
    const tokens = [...masked.slice(start, end).matchAll(controls)].map(token => controlState(token[0]));
    result.push({ source: text, start, end, state: tokens.includes('multipart') ? 'multipart' : state });
    for (const control of tokens) state = transitions[state][control];
  };
  // No boundary at a decimal, slash, comma, semicolon, or publisher line wrap.
  const boundaries = [...source.matchAll(/\n\s*\n|(?<=\.)\s+(?=[A-Z0-9*#])/g)]
    .map(separator => ({ start: separator.index, end: separator.index + separator[0].length, marker: false }));
  boundaries.push(...markers.map(marker => ({ ...marker, marker: true })));
  for (const separator of boundaries.sort((a, b) => a.start - b.start)) {
    if (separator.start < start) continue;
    consume(separator.start);
    if (result.length > maxClauses) return;
    start = separator.start;
    // A proven marker is still displayed from its exact source span. It does
    // not change scope; in particular, it cannot close an earlier instruction.
    if (separator.marker) consume(separator.end);
    start = separator.end;
  }
  consume(source.length);
  return result.length <= maxClauses ? result : undefined;
}
