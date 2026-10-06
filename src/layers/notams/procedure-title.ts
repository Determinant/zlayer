type State = 'prefix' | 'facility' | 'designation' | 'qualification' | 'done';
const variants = /^[A-Z]$/, runwaySides = new Set(['L', 'R', 'C']);
const categories = new Set(['I', 'II', 'III']);

/** Title tokens have no semantic meaning outside their current grammar state.
 * Keep the original title for identity/evidence; this cursor only recognizes it. */
class TitleCursor {
  readonly tokens: string[];
  position = 0;
  constructor(source: string) { this.tokens = source.toUpperCase().match(/[A-Z]+|\d+|\S/g) ?? []; }
  peek(ahead = 0) { return this.tokens[this.position + ahead]; }
  take(text: string) {
    if (this.peek() !== text) return false;
    this.position++; return true;
  }
  variant() { if (variants.test(this.peek() ?? '')) this.position++; }
  dme(): boolean { return !this.take('/') || this.take('DME'); }
  get done() { return this.position === this.tokens.length; }
}

function facility(cursor: TitleCursor): { type: string; gps: boolean; combined: boolean } | undefined {
  const type = cursor.peek();
  if (!type || !['ILS', 'LOC', 'VOR', 'TACAN', 'RNAV', 'GPS', 'NDB', 'LDA', 'SDF', 'GLS'].includes(type)) return;
  cursor.position++;
  let gps = false, combined = false;
  if (['ILS', 'LOC', 'VOR', 'NDB', 'LDA'].includes(type) && !cursor.dme()) return;
  if (type === 'LOC') cursor.take('BC');
  if (type === 'RNAV' && cursor.take('(')) {
    gps = cursor.take('GPS');
    if (!gps && !cursor.take('RNP') || !cursor.take(')')) return;
  }
  if (type === 'ILS' || type === 'RNAV') cursor.take('PRM');
  cursor.variant();
  if (cursor.take('OR')) {
    const branch = cursor.peek();
    const allowed = type === 'ILS' ? ['LOC'] : type === 'VOR' ? ['TACAN', 'GPS'] : type === 'TACAN' ? ['VOR'] : [];
    if (!branch || !allowed.includes(branch)) return;
    cursor.position++;
    if (type === 'ILS' && !cursor.dme()) return;
    cursor.variant(); combined = true;
  }
  return { type, gps, combined };
}

function qualification(cursor: TitleCursor): boolean {
  const parenthesized = cursor.take('(');
  if (parenthesized && cursor.take('CONVERGING')) return cursor.take(')');
  if (parenthesized && cursor.take('CLOSE')) return cursor.take('PARALLEL') && cursor.take(')');
  cursor.take('SA');
  if (!cursor.take('CAT') || !categories.has(cursor.peek() ?? '')) return false;
  cursor.position++;
  while (['-', '/', 'AND'].includes(cursor.peek() ?? '')) {
    cursor.position++;
    if (!categories.has(cursor.peek() ?? '')) return false;
    cursor.position++;
  }
  return !parenthesized || cursor.take(')');
}

/** Bounded recognizer for a complete approach title. States own the meaning of
 * each token; unknown prefixes, incomplete groups and trailing prose fail closed.
 * This establishes a written identity, never the applicability of a NOTAM. */
export function isApproachTitle(source: string): boolean {
  if (!source.trim() || source.length > 320) return false;
  const cursor = new TitleCursor(source);
  if (cursor.take('RADAR')) {
    cursor.take('-');
    if (!/^\d+$/.test(cursor.peek() ?? '')) return false;
    cursor.position++; return cursor.done;
  }
  let state: State = 'prefix', high = false, copter = false;
  let aid: ReturnType<typeof facility>;
  while (state !== 'done') {
    switch (state) {
      case 'prefix':
        high = cursor.take('HI');
        if (high && !cursor.take('-')) return false;
        copter = cursor.take('COPTER');
        if (!copter) cursor.take('CONVERGING');
        state = 'facility'; break;
      case 'facility':
        aid = facility(cursor);
        if (!aid) return false;
        state = 'designation'; break;
      case 'designation':
        if (cursor.take('RWY')) {
          const number = cursor.peek();
          if (!number || !/^\d{1,2}$/.test(number) || Number(number) < 1 || Number(number) > 36) return false;
          cursor.position++;
          if (runwaySides.has(cursor.peek() ?? '')) cursor.position++;
          while (cursor.take('/')) {
            if (!runwaySides.has(cursor.peek() ?? '')) return false;
            cursor.position++;
          }
        } else if (cursor.take('-')) {
          if (!variants.test(cursor.peek() ?? '')) return false;
          cursor.position++;
        } else if (copter && !high && aid!.type === 'RNAV' && aid!.gps && !aid!.combined && /^\d{3}$/.test(cursor.peek() ?? '')) {
          cursor.position++; return cursor.done;
        } else return false;
        state = 'qualification'; break;
      case 'qualification':
        if (cursor.done) state = 'done';
        else if (!qualification(cursor)) return false;
        break;
    }
  }
  return true;
}
