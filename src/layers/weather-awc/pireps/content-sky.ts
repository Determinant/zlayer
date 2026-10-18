import { Cursor, numeric, feet, range } from './content-tokens';

type Height = { low: number; high?: number; qualifier?: string } | { unscaled: string } | { variable: true; sample?: number } | 'unknown';
const known = (height?: Height): height is Extract<Height, { low: number }> => !!height && typeof height === 'object' && 'low' in height;
type Sky = { cover?: string; base?: Height; top?: Height; clearAbove?: number; clearAt?: number; verticalVisibility?: number;
  unassignedHeights?: [number, number]; unknownScope?: boolean; unspecifiedHeight?: number; layersAbove?: boolean };
const covers: Record<string, string> = { FEW: 'FEW', SCT: 'SCT', BKN: 'BKN', OVC: 'OVC', SKC: 'SKC', CLR: 'CLR', IMC: 'IMC', VMC: 'VMC', UNKN: 'Unspecified' };
const bases = new Set(['B', 'BA', 'BASE', 'BASES']);
const tops = new Set(['T', 'TOP', 'TOPS', 'TPS']);
function skyHeight(cursor: Cursor, allowRange: boolean): Height | undefined {
  if (cursor.take('UNKN') || cursor.take('UNK')) return 'unknown';
  if (cursor.take('VRB')) {
    if (!cursor.take('/')) return { variable: true };
    const token = cursor.peek();
    if (!numeric(token)) return;
    cursor.position++; return { variable: true, sample: feet(token) };
  }
  const qualifier = cursor.take('ABV') || cursor.take('ABOVE') ? 'above' : cursor.take('BLO') || cursor.take('BELOW') ? 'below' : undefined;
  const token = cursor.peek();
  if (token && /^\d{4}$/.test(token) && !qualifier) { cursor.position++; return { unscaled: token }; }
  if (!numeric(token)) return;
  cursor.position++;
  const low = feet(token);
  if (allowRange && (cursor.peek() === '-' || cursor.peek() === 'V') && numeric(cursor.peek(1))) {
    cursor.position++;
    const high = feet(cursor.tokens[cursor.position++]!);
    if (high < low) return;
    return { low, high, ...(qualifier ? { qualifier } : {}) };
  }
  return { low, ...(qualifier ? { qualifier } : {}) };
}
const heightLabel = (height?: Height): string => !height || height === 'unknown' ? '?' :
  'unscaled' in height ? `${height.unscaled} (units unresolved)` : 'variable' in height ?
    `variable${height.sample === undefined ? '' : ` (reported ${height.sample} ft MSL; bounds unspecified)`}` :
    `${height.qualifier ? `${height.qualifier} ` : ''}${height.low}${height.high === undefined ? '' : `–${height.high}`}`;
function skyLabel(sky: Sky): string {
  if (sky.verticalVisibility !== undefined) return `Vertical visibility ${sky.verticalVisibility} ft`;
  if (sky.clearAbove !== undefined) return `${sky.cover} above ${sky.clearAbove} ft MSL`;
  if (sky.clearAt !== undefined) return `${sky.cover} at ${sky.clearAt} ft MSL${sky.layersAbove ? '; clouds above (heights unspecified)' : ''}`;
  if (sky.unassignedHeights) return `${sky.cover ?? 'Unspecified'} · reported heights ${sky.unassignedHeights.join(' / ')} ft MSL (base/top roles unspecified)`;
  if (sky.unknownScope) return `${sky.cover} · reported height ${sky.unspecifiedHeight} ft MSL (UNKN qualifier scope unclear)`;
  const base = sky.base, top = sky.top;
  const uncertain = [base, top].some(value => value && value !== 'unknown' && !known(value));
  const complex = [base, top].some(value => known(value) && (value.high !== undefined || value.qualifier));
  const inverted = known(base) && known(top) && base.low > top.low;
  const heights = uncertain ? [base === undefined ? '' : `base ${heightLabel(base)}${known(base) ? ' ft MSL' : ''}`,
    top === undefined ? '' : `top ${heightLabel(top)}${known(top) ? ' ft MSL' : ''}`].filter(Boolean).join(' / ')
    : base === undefined && top === 'unknown' ? 'top unknown'
    : complex ? `base ${heightLabel(base)} / top ${heightLabel(top)} ft MSL`
    : inverted ? `reported base ${heightLabel(base)} / top ${heightLabel(top)} ft MSL (inconsistent)`
      : base !== undefined || top !== undefined ? `${heightLabel(base)}–${heightLabel(top)} ft MSL` : '';
  return [sky.cover ?? 'Unspecified', heights].filter(Boolean).join(' · ') + (sky.layersAbove ? '; additional layers above (heights unspecified)' : '');
}

/** Coverage/base/top states accept explicit nonstandard B/T shorthand and keep
 * ranges and qualifiers. A bare hyphen after a base cannot guess whether the
 * next height is a variable base or a top: both numbers remain unassigned. */
export function readPirepSky(text: string): string[] | undefined {
  const cursor = new Cursor(text);
  if (!cursor.tokens.length || cursor.tokens.length > 512) return;
  const output: string[] = [];
  let sky: Sky = {}, precedingTop: Height | undefined, state: 'part' | 'base' | 'top' | 'vertical' | 'clear-at' | 'end' = 'part', explicit = false;
  const flush = () => { if (!Object.keys(sky).length) return false; output.push(skyLabel(sky)); precedingTop = sky.top; sky = {}; return true; };
  while (true) {
    if (output.length > 100) return;
    switch (state) {
      case 'part': {
        if (cursor.done) { state = 'end'; break; }
        const token = cursor.peek()!;
        const complete = sky.verticalVisibility !== undefined || sky.clearAbove !== undefined || sky.unassignedHeights !== undefined ||
          sky.unknownScope && sky.unspecifiedHeight !== undefined || sky.layersAbove;
        if (complete && token !== '/') return;
        if (sky.clearAt !== undefined && token !== '/') {
          cursor.take(',');
          if (!(cursor.phrase('CLOUDS', 'ABOVE') || cursor.phrase('CLOUDS', 'ABV'))) return;
          sky.layersAbove = true;
          cursor.take('.');
          if (cursor.phrase('NO', 'ESTIMATE')) cursor.take('.');
          break;
        }
        if (token.startsWith('UNKN') && covers[token.slice(4)]) {
          cursor.tokens.splice(cursor.position, 1, 'UNKN', token.slice(4)); continue;
        }
        if (token === 'UNKN' && covers[cursor.peek(1) ?? ''] && numeric(cursor.peek(2)) && !Object.keys(sky).length) {
          sky.unknownScope = true; cursor.position++; break;
        }
        if (sky.unknownScope && numeric(token)) {
          if (sky.unspecifiedHeight !== undefined) return;
          sky.unspecifiedHeight = feet(token); cursor.position++; break;
        }
        // Compact unknown-height tokens are split only in the sky production.
        // Do not extract arbitrary known words from an unsupported suffix.
        if (!tops.has(token) && !bases.has(token) && !covers[token]) {
          const prefix = [...tops, ...bases, ...Object.keys(covers)].find(prefix =>
            token.startsWith(prefix) && ['UNKN', 'UNK'].includes(token.slice(prefix.length)));
          if (prefix) { cursor.tokens.splice(cursor.position, 1, prefix, token.slice(prefix.length)); continue; }
        }
        if (token === '/') {
          if (/^Z[A-Z]{2}$/.test(cursor.peek(1) ?? '') && cursor.position + 2 === cursor.tokens.length) { cursor.position += 2; state = 'end'; break; }
          if (!flush()) return;
          cursor.position++; break;
        }
        if (token === '-') {
          const next = cursor.peek(1) ?? '';
          if (known(sky.base) && sky.base.high === undefined && !sky.base.qualifier && sky.top === undefined && numeric(next)) {
            sky.unassignedHeights = [sky.base.low, feet(next)]; delete sky.base; cursor.position += 2;
            // The unassigned pair is a complete layer, not a new base for a later TOP.
            if (!cursor.done && cursor.peek() !== '/') return;
            break;
          }
          if (sky.base === undefined && numeric(next)) { cursor.position++; state = 'base'; explicit = false; break; }
          if (!tops.has(next) && ![...tops].some(prefix => next.startsWith(prefix) && ['UNKN', 'UNK'].includes(next.slice(prefix.length)))) return;
          cursor.position++; break;
        }
        if (bases.has(token) || tops.has(token)) {
          state = bases.has(token) ? 'base' : 'top'; explicit = true; cursor.position++; break;
        }
        if (token === 'VV' && !Object.keys(sky).length) { cursor.position++; state = 'vertical'; break; }
        if (token === 'AT' && ['SKC', 'CLR'].includes(sky.cover ?? '') && sky.base === undefined && sky.clearAt === undefined) {
          cursor.position++; state = 'clear-at'; break;
        }
        if (cursor.phrase('LYRS', 'ABV') || cursor.phrase('LAYERS', 'ABOVE')) {
          if (sky.layersAbove || sky.top === undefined) return;
          sky.layersAbove = true; break;
        }
        const clearTop = sky.top ?? precedingTop;
        if (['SKC', 'CLR'].includes(token) && known(clearTop) && clearTop.high === undefined && !clearTop.qualifier) {
          if (Object.keys(sky).length) flush();
          sky = { cover: token, clearAbove: clearTop.low };
          cursor.position++; cursor.take('ABV') || cursor.take('ABOVE'); break;
        }
        if (covers[token]) {
          if (sky.cover && !flush()) return;
          sky.cover = range(cursor, covers)!;
          if (!sky.unknownScope && (numeric(cursor.peek()) || ['UNKN', 'UNK'].includes(cursor.peek() ?? ''))) {
            state = sky.base === undefined ? 'base' : 'top'; explicit = false;
          }
          break;
        }
        if (numeric(token) && sky.base === undefined) { state = 'base'; explicit = false; break; }
        return;
      }
      case 'base': case 'top': {
        if (explicit && state === 'base' && covers[cursor.peek() ?? '']) {
          if (sky.cover) return;
          sky.cover = range(cursor, covers)!;
        }
        if (sky[state] !== undefined) return;
        const height = explicit && cursor.done ? 'unknown' : skyHeight(cursor, explicit);
        if (height === undefined) return;
        sky[state] = height; state = 'part'; break;
      }
      case 'vertical': case 'clear-at': {
        const token = cursor.peek();
        if (!numeric(token)) return;
        sky[state === 'vertical' ? 'verticalVisibility' : 'clearAt'] = feet(token);
        cursor.position++; state = 'part'; break;
      }
      case 'end': return flush() ? output : undefined;
    }
  }
}
