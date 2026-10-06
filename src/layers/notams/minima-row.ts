import type { NotamMinimumRow } from './minima';

type Token = { text: string; start: number; end: number };
type State = 'field' | 'value' | 'separator' | 'category-end' | 'done';
const fields = new Set(['DA', 'MDA', 'RA', 'HAT', 'HAA', 'HAS', 'VIS', 'VISIBILITY', 'RVR', 'MINIMUMS']);
const heights = new Set(['HAT', 'HAA', 'HAS']);
const isNumber = (token?: Token) => !!token && /^\d+(?:\.\d+)?$/.test(token.text);
const isInteger = (token?: Token) => !!token && /^\d+$/.test(token.text);

/** Lexical tokens retain source positions. Slashes remain punctuation until the
 * current field decides whether they separate labels, values or a fraction. */
class RowCursor {
  readonly tokens: Token[];
  position = 0;
  constructor(readonly source: string) {
    this.tokens = [...source.matchAll(/\d+(?:\.\d+)?|[A-Z]+|\S/g)]
      .map(m => ({ text: m[0], start: m.index, end: m.index + m[0].length }));
  }
  peek(ahead = 0) { return this.tokens[this.position + ahead]; }
  take(text: string) {
    if (this.peek()?.text !== text) return false;
    this.position++; return true;
  }
  slice(start: number) { return this.source.slice(this.tokens[start]!.start, this.tokens[this.position - 1]!.end); }
  get done() { return this.position === this.tokens.length; }
}

function category(cursor: RowCursor): string | undefined {
  const start = cursor.position;
  if (cursor.take('ALL')) {
    if (cursor.take('CATS') || cursor.take('CAT')) return 'All categories';
    cursor.position = start; return;
  }
  if (!(cursor.take('CAT') || cursor.take('CATS'))) return;
  if (!/^[A-E]$/.test(cursor.peek()?.text ?? '')) { cursor.position = start; return; }
  cursor.position++;
  while (cursor.peek()?.text === '/' || cursor.peek()?.text === 'AND') {
    cursor.position++;
    if (!/^[A-E]$/.test(cursor.peek()?.text ?? '')) { cursor.position = start; return; }
    cursor.position++;
  }
  return cursor.slice(start).replace(/^CATS /, 'CAT ');
}

function fieldValue(cursor: RowCursor, field: string): string | undefined {
  if (cursor.take('NA')) return 'NA';
  if (field === 'MINIMUMS') return;
  const visibility = field === 'VIS' || field === 'VISIBILITY';
  const rvr = visibility && cursor.take('RVR');
  const start = cursor.position;
  if (!(field === 'RVR' || rvr ? isInteger(cursor.peek()) : isNumber(cursor.peek()))) return;
  cursor.position++;
  if (visibility && !rvr) {
    // Fraction punctuation has meaning only in a visibility-value state.
    const integer = isInteger(cursor.tokens[start]);
    if (cursor.peek()?.text === '-' || isInteger(cursor.peek())) {
      if (!integer) return;
      cursor.take('-');
      if (!isInteger(cursor.peek())) return;
      cursor.position++;
      if (!cursor.take('/') || !isInteger(cursor.peek())) return;
      cursor.position++;
    } else if (cursor.peek()?.text === '/' && isInteger(cursor.peek(1))) {
      if (!integer) return;
      cursor.position += 2;
    }
    if (['SM', 'MILE', 'MILES'].includes(cursor.peek()?.text ?? '')) cursor.position++;
  } else if (field !== 'RVR' && !rvr) cursor.take('FT');
  const value = cursor.slice(start);
  // The reversed spelling is explicit (VIS 4500 RVR), never a borrowed RVR label.
  const trailingRvr = visibility && !rvr && /^\d+$/.test(value) && cursor.take('RVR');
  return `${rvr || trailingRvr ? 'RVR ' : ''}${value}`;
}

/** Field-binding state machine. Category scope belongs to this row; a label owns
 * exactly its next value. A failed transition rejects the entire row, including
 * values already recognized. No recovery step invents an omitted label or unit. */
export function minimumRow(source: string, previous?: NotamMinimumRow): NotamMinimumRow | undefined {
  const cursor = new RowCursor(source), values: NotamMinimumRow['values'] = [];
  let categories = category(cursor);
  // Only a previous, single explicit visibility row licenses category shorthand.
  if (categories && isNumber(cursor.peek()) && previous?.values.length === 1 &&
      previous.values[0]!.label === 'Visibility' && !previous.values[0]!.value.startsWith('RVR ')) {
    const value = fieldValue(cursor, 'VIS');
    return value && cursor.done ? { categories, values: [{ label: 'Visibility', value }] } : undefined;
  }
  let state: State = 'field', pending: { field: string; marker: string }[] = [], pair = false;
  const readCategory = () => {
    const next = category(cursor);
    if (next && categories) return false;
    if (next) categories = next;
    return true;
  };
  // Every transition consumes a token or moves to the next state; the row is
  // bounded by the owning clause and at most eight explicitly labeled fields.
  while (state !== 'done') {
    switch (state) {
      case 'field': {
        const field = cursor.peek()?.text;
        if (!field || !fields.has(field) || values.length >= 8) return;
        cursor.position++;
        const marker = ['*', '#'].includes(cursor.peek()?.text ?? '') ? cursor.tokens[cursor.position++]!.text : '';
        pending = [{ field, marker }]; pair = false;
        // DA/HAT 600/300 and DA/RVR/HAT 600/2400/300 declare ordered labels.
        while (cursor.peek()?.text === '/' && fields.has(cursor.peek(1)?.text ?? '')) {
          cursor.position++;
          pending.push({ field: cursor.tokens[cursor.position++]!.text, marker: '' });
          if (pending.length > 3) return;
        }
        if (pending.length > 1) {
          if (marker || !['DA', 'MDA'].includes(field) ||
              !heights.has(pending.at(-1)!.field) || pending.length === 3 && pending[1]!.field !== 'RVR') return;
          pair = true;
        }
        if (values.length + pending.length > 8) return;
        cursor.take(':');
        // A category between a later label and value cannot retroactively scope
        // the fields already consumed. Keep such a mixed-scope row as prose.
        if (values.length && ['CAT', 'CATS', 'ALL'].includes(cursor.peek()?.text ?? '')) return;
        if (!readCategory()) return;
        state = 'value'; break;
      }
      case 'value': {
        for (const [index, { field, marker }] of pending.entries()) {
          if (index && !cursor.take('/')) return;
          const value = fieldValue(cursor, field);
          if (!value || pair && value === 'NA' || heights.has(field) &&
              values.some(v => /^(?:DA|MDA)[*#]?$/.test(v.label) && v.value === 'NA')) return;
          const label = field === 'VIS' || field === 'VISIBILITY' ? 'Visibility' : field === 'MINIMUMS' ? 'Minimums' : field;
          if (values.some(v => v.label === `${label}${marker}`)) return;
          values.push({ label: `${label}${marker}`, value });
        }
        state = 'separator'; break;
      }
      case 'separator': {
        if (cursor.done) { state = 'done'; break; }
        if (cursor.peek()?.text === 'CAT' || cursor.peek()?.text === 'CATS' || cursor.peek()?.text === 'ALL') {
          if (!readCategory()) return;
          state = 'category-end'; break;
        }
        if (pair) return;
        const separated = cursor.take('/') || cursor.peek()!.start > cursor.tokens[cursor.position - 1]!.end;
        if (!separated) return;
        state = 'field'; break;
      }
      case 'category-end':
        if (!cursor.done) return;
        state = 'done'; break;
    }
  }
  return values.length ? { values, ...(categories ? { categories } : {}) } : undefined;
}
