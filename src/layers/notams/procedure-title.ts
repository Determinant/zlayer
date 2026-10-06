type State = 'prefix' | 'facility' | 'designation' | 'qualification' | 'done';
const variants = /^[A-Z]$/, runwaySides = new Set(['L', 'R', 'C']);
const categories = new Set(['I', 'II', 'III']);
const categoryNumbers: Record<string, string> = { '1': 'I', '2': 'II', '3': 'III' };
export type ApproachCategory = { special: boolean; values: string[] };
export type ApproachIdentity = { key: string; base: string; categories: ApproachCategory[] };

/** Title tokens have no semantic meaning outside their current grammar state.
 * Keep the original title for identity/evidence; build a separate comparison key. */
class TitleCursor {
  readonly tokens: string[];
  readonly key: string[];
  categories: ApproachCategory[] = [];
  position = 0;
  constructor(source: string) {
    this.tokens = source.toUpperCase().match(/[A-Z]+|\d+|\S/g) ?? [];
    this.key = this.tokens.map(token => /^[A-Z0-9]+$/.test(token) ? token : '');
  }
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

function qualification(cursor: TitleCursor, type: string): boolean {
  const start = cursor.position;
  const parenthesized = cursor.take('(');
  if (parenthesized && cursor.take('CONVERGING')) return cursor.take(')');
  if (parenthesized && cursor.take('CLOSE')) {
    if (!cursor.tokens.includes('PRM') || !cursor.take('PARALLEL') || !cursor.take(')')) return false;
    // FAA PRM PDF titles include this phrase while the catalog omits it.
    cursor.key.fill('', start, cursor.position);
    return true;
  }
  const sat = cursor.take('SAT'), special = sat || cursor.take('SA');
  if (!cursor.take('CAT')) return false;
  const takeCategory = () => {
    const token = cursor.peek() ?? '', category = categoryNumbers[token] ?? token;
    if (!categories.has(category)) return;
    cursor.position++;
    return category;
  };
  const first = takeCategory(); if (!first) return false;
  const values = [first];
  while (['-', '/', 'AND', '&'].includes(cursor.peek() ?? '')) {
    const separator = cursor.tokens[cursor.position++];
    const category = takeCategory(); if (!category) return false;
    if (separator === '-') {
      const previous = values.at(-1)!.length;
      if (category.length <= previous) return false;
      for (let number = previous + 1; number < category.length; number++) values.push('I'.repeat(number));
    }
    values.push(category);
  }
  // FAA EWR 7/7214 uses SAT CAT I and SA CAT I for the same ILS;
  // KOAK 6/6268 and its amendment 8B plate corroborate this exact spelling alias.
  if (sat && (type !== 'ILS' || values.length !== 1 || first !== 'I')) return false;
  if (parenthesized && !cursor.take(')')) return false;
  if (cursor.categories.some(category => category.special === special)) return false;
  cursor.categories.push({ special, values: [...new Set(values)].sort((a, b) => a.length - b.length) });
  cursor.key.fill('', start, cursor.position);
  // Delimit categories: CAT I/II must never collide with CAT III after punctuation removal.
  cursor.key[start] = `${special ? 'SA' : ''}CAT[${[...new Set(values)].sort((a, b) => a.length - b.length).join(',')}]`;
  return true;
}

/** Bounded recognizer for a complete approach title. States own the meaning of
 * each token; unknown prefixes, incomplete groups and trailing prose fail closed.
 * This establishes a written identity, never the applicability of a NOTAM. */
export function approachTitleIdentity(source: string): ApproachIdentity | undefined {
  if (!source.trim() || source.length > 320) return;
  const cursor = new TitleCursor(source);
  const identity = (): ApproachIdentity => {
    const key = cursor.key.join('');
    return { key, base: key.replace(/(?:SA)?CAT\[[I,]+\]/g, ''), categories: cursor.categories };
  };
  if (cursor.take('RADAR')) {
    cursor.take('-');
    if (!/^\d+$/.test(cursor.peek() ?? '')) return;
    cursor.position++; return cursor.done ? identity() : undefined;
  }
  let state: State = 'prefix', high = false, copter = false, implicitRunway = false;
  let aid: ReturnType<typeof facility>;
  while (state !== 'done') {
    switch (state) {
      case 'prefix':
        high = cursor.take('HI');
        if (high && !cursor.take('-')) return;
        copter = cursor.take('COPTER');
        if (!copter) cursor.take('CONVERGING');
        state = 'facility'; break;
      case 'facility':
        aid = facility(cursor);
        if (!aid) return;
        state = 'designation'; break;
      case 'designation':
        if (cursor.take('RWY') || (aid!.type === 'ILS' && /^\d{1,2}$/.test(cursor.peek() ?? '') && (implicitRunway = true))) {
          const number = cursor.peek();
          if (!number || !/^\d{1,2}$/.test(number) || Number(number) < 1 || Number(number) > 36) return;
          cursor.key[cursor.position] = `${implicitRunway ? 'RWY' : ''}${Number(number)}`;
          cursor.position++;
          if (runwaySides.has(cursor.peek() ?? '')) cursor.position++;
          while (cursor.take('/')) {
            if (!runwaySides.has(cursor.peek() ?? '')) return;
            cursor.position++;
          }
        } else if (cursor.take('-')) {
          if (!variants.test(cursor.peek() ?? '')) return;
          cursor.position++;
        } else if (copter && !high && aid!.type === 'RNAV' && aid!.gps && !aid!.combined && /^\d{3}$/.test(cursor.peek() ?? '')) {
          cursor.position++; return cursor.done ? identity() : undefined;
        } else return;
        state = 'qualification'; break;
      case 'qualification':
        if (cursor.done) state = 'done';
        else if (!qualification(cursor, aid!.type)) return;
        break;
    }
  }
  // The observed omitted-RWY form is an ILS category heading, not a bearing.
  return implicitRunway && !cursor.categories.length ? undefined : identity();
}

export function approachTitleKey(source: string): string | undefined { return approachTitleIdentity(source)?.key; }
export function isApproachTitle(source: string): boolean { return approachTitleKey(source) !== undefined; }
