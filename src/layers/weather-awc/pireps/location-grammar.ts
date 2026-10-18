import type { Distance, LocalDescription, Radial, Read } from './location';

type Token = { text: string; start: number; end: number };
const noMatch = { kind: 'unrecognized' } as const;
const parsed = <T>(value: T): Read<T> => ({ kind: 'parsed', value });
const reject = (reason: string) => ({ kind: 'rejected', reason } as const);
const compass: Record<string, number> = { N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
  S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5 };
const directionCode = (word: string) => word.replaceAll('NORTH', 'N').replaceAll('SOUTH', 'S').replaceAll('EAST', 'E').replaceAll('WEST', 'W');
const isNumber = (token?: Token) => !!token && /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(token.text);
const isInteger = (token?: Token) => !!token && /^\d+$/.test(token.text);

/** Lexical boundaries retain source positions. Only the active state may split
 * compact units or digit groups; arbitrary words never supply an inferred token. */
class LocationCursor {
  readonly tokens: Token[];
  position = 0;
  constructor(source: string) {
    this.tokens = [...source.matchAll(/\d+(?:\.\d+)?|\.\d+|[A-Z]+|\S/g)]
      .map(m => ({ text: m[0], start: m.index, end: m.index + m[0].length }));
  }
  peek(ahead = 0) { return this.tokens[this.position + ahead]; }
  take(text: string) { if (this.peek()?.text !== text) return false; this.position++; return true; }
  prefix(length: number) {
    const token = this.peek()!;
    const value = token.text.slice(0, length);
    if (length === token.text.length) this.position++;
    else this.tokens[this.position] = { ...token, text: token.text.slice(length), start: token.start + length };
    return value;
  }
  get done() { return this.position === this.tokens.length; }
}

function amount(cursor: LocationCursor): number | undefined {
  if (!isNumber(cursor.peek())) return;
  const first = cursor.tokens[cursor.position++]!.text;
  if (first.split('.')[0]!.length > 3) return;
  let value = Number(first);
  // A slash is a fraction only in the amount state. Require a complete positive
  // denominator and a proper fraction, including an optional mixed-number whole.
  const mixed = isInteger(cursor.peek()) && cursor.peek(1)?.text === '/';
  if (mixed || cursor.peek()?.text === '/') {
    if (!/^\d+$/.test(first)) return;
    const numerator = mixed ? Number(cursor.tokens[cursor.position++]!.text) : value;
    if (!cursor.take('/') || !isInteger(cursor.peek())) return;
    const denominator = Number(cursor.tokens[cursor.position++]!.text);
    if (denominator <= 0 || denominator > 999 || numerator >= denominator) return;
    value = (mixed ? value : 0) + numerator / denominator;
  }
  return value;
}

function unit(cursor: LocationCursor): string | undefined {
  const word = cursor.peek()?.text ?? '';
  for (const name of ['MILES', 'MILE', 'NM', 'SM', 'MI']) {
    if (!word.startsWith(name)) continue;
    const tail = word.slice(name.length);
    if (tail && !Object.hasOwn(compass, directionCode(tail)) && tail !== 'FINAL') continue;
    cursor.prefix(name.length); return name;
  }
  return undefined;
}

function direction(cursor: LocationCursor): string | undefined {
  let code = '';
  for (let count = 0; count < 3; count++) {
    const next = directionCode(cursor.peek()?.text ?? '');
    if (!Object.hasOwn(compass, next)) break;
    code += next; cursor.position++;
    if (cursor.peek()?.text === '-') {
      if (!Object.hasOwn(compass, directionCode(cursor.peek(1)?.text ?? ''))) return;
      cursor.position++;
    }
  }
  return Object.hasOwn(compass, code) ? code : undefined;
}

/** Procedure qualifiers, variant, runway and suffix have ordered ownership. A
 * failed transition leaves the complete description unrecognized, not partial. */
function procedure(cursor: LocationCursor, distance?: Distance): Read<LocalDescription> {
  type State = 'method' | 'qualifier' | 'variant' | 'runway' | 'suffix' | 'end';
  let state: State = 'method', method = '', variant = '', runway = '', departure = false;
  while (true) {
    switch (state) {
      case 'method':
        cursor.take('ON');
        method = cursor.peek()?.text ?? '';
        if (!['RNAV', 'ILS', 'LOC', 'GPS', 'VOR', 'NDB', 'FINAL', 'DEP', 'DEPARTURE'].includes(method)) return noMatch;
        departure = method === 'DEP' || method === 'DEPARTURE';
        cursor.position++; state = 'qualifier'; break;
      case 'qualifier':
        if (method === 'RNAV' && cursor.take('(')) {
          const qualifier = cursor.peek()?.text;
          if (qualifier !== 'GPS' && qualifier !== 'RNP') return noMatch;
          cursor.position++; if (!cursor.take(')')) return noMatch;
          method += ` (${qualifier})`;
        } else if (method === 'ILS' && cursor.take('OR')) {
          if (!cursor.take('LOC')) return noMatch;
          method += ' OR LOC';
        } else if ((method === 'LOC' || method === 'VOR') && cursor.take('/')) {
          if (!cursor.take('DME')) return noMatch;
          method += '/DME';
        }
        state = 'variant'; break;
      case 'variant':
        if (!departure && ['X', 'Y', 'Z'].includes(cursor.peek()?.text ?? '')) variant = cursor.tokens[cursor.position++]!.text;
        if (!departure) { cursor.take('APCH') || cursor.take('APPROACH'); }
        state = 'runway'; break;
      case 'runway': {
        const namedRunway = cursor.take('RWY') || cursor.take('RUNWAY');
        if (distance && method === 'FINAL' && cursor.done && !namedRunway && !variant) return parsed({ kind: 'approach', name: 'FINAL', distance });
        const number = cursor.peek()?.text;
        if (!number || !/^\d{1,2}$/.test(number)) return noMatch;
        if (Number(number) < 1 || Number(number) > 36) return reject(`${departure ? 'Departure' : 'Approach'} runway out of range`);
        runway = number.padStart(2, '0'); cursor.position++;
        if (['L', 'R', 'C'].includes(cursor.peek()?.text ?? '')) runway += cursor.tokens[cursor.position++]!.text;
        state = 'suffix'; break;
      }
      case 'suffix':
        if (!departure) { cursor.take('APCH') || cursor.take('APPROACH'); }
        state = 'end'; break;
      case 'end':
        if (!cursor.done) return noMatch;
        return departure ? parsed({ kind: 'departure', runway })
          : parsed({ kind: 'approach', name: `${method}${variant ? ` ${variant}` : ''} RWY ${runway}`, ...(distance ? { distance } : {}) });
    }
  }
}

/** Description machine: amount → unit → direction, or direction → amount →
 * unit, then end. An explicit reference is handled by the owning field machine. */
export function localDescription(text: string): Read<LocalDescription> {
  const cursor = new LocationCursor(text);
  type State = 'start' | 'amount' | 'unit' | 'direction' | 'end';
  let state: State = 'start', value: number | undefined, units: string | undefined, code: string | undefined;
  while (true) {
    switch (state) {
      case 'start':
        // A bare digit group belongs to the radial/distance grammar, not an
        // amount with an invented unit or direction.
        if (cursor.tokens.length === 1 && isNumber(cursor.peek())) return noMatch;
        if (isNumber(cursor.peek())) state = 'amount';
        else if (Object.hasOwn(compass, directionCode(cursor.peek()?.text ?? ''))) state = 'direction';
        else return procedure(cursor);
        break;
      case 'amount':
        value = amount(cursor);
        if (value === undefined) return reject('Invalid location distance');
        state = 'unit'; break;
      case 'unit':
        units = unit(cursor);
        state = code || cursor.done ? 'end' : 'direction'; break;
      case 'direction':
        if (value !== undefined && cursor.peek()?.text === 'FINAL') {
          const distanceNm = value * (units === 'SM' ? 1609.344 / 1852 : 1);
          if (distanceNm > 999) return reject('Location distance out of range');
          return procedure(cursor, { value, unit: units === 'SM' ? 'SM' : 'NM', distanceNm,
            ...(units && ['MI', 'MILE', 'MILES'].includes(units) ? { assumedUnit: true } : {}) });
        }
        code = direction(cursor);
        if (!code) return noMatch;
        state = value === undefined ? 'amount' : 'end'; break;
      case 'end': {
        if (!cursor.done || value === undefined || !code && !units) return noMatch;
        const distance = { value, unit: units === 'SM' ? 'SM' as const : 'NM' as const,
          distanceNm: value * (units === 'SM' ? 1609.344 / 1852 : 1),
          ...(units && ['MI', 'MILE', 'MILES'].includes(units) ? { assumedUnit: true as const } : {}) };
        if (distance.distanceNm > 999) return reject('Location distance out of range');
        return parsed(code ? { kind: 'compass', distance, direction: code, radial: compass[code]! } : { kind: 'distance', distance });
      }
    }
  }
}

/** Bearing and distance states split a compact digit token at one explicit
 * width. Spaces fix boundaries; trailing tokens and partial digits never pass. */
export function radialFields(text: string, width = 3): { radial: number; distance?: string } | undefined {
  const cursor = new LocationCursor(text);
  let state: 'bearing' | 'distance' | 'end' = 'bearing', radial = 0, distance: string | undefined;
  while (true) {
    switch (state) {
      case 'bearing':
        if (!isInteger(cursor.peek()) || cursor.peek()!.text.length < width) return;
        radial = Number(cursor.prefix(width)); state = 'distance'; break;
      case 'distance':
        if (!cursor.done) {
          if (!isInteger(cursor.peek()) || cursor.peek()!.text.length > 4) return;
          distance = cursor.tokens[cursor.position++]!.text;
        }
        state = 'end'; break;
      case 'end': return cursor.done ? { radial, ...(distance === undefined ? {} : { distance }) } : undefined;
    }
  }
}

export function radialDistance(text: string): Read<Radial> {
  const ordinary = radialFields(text);
  if (ordinary?.distance !== undefined && ordinary.radial <= 360 && Number(ordinary.distance) <= 999) {
    return parsed({ radial: ordinary.radial % 360, distanceNm: Number(ordinary.distance),
      ...(ordinary.distance.length === 3 ? {} : { recovered: true as const }) });
  }
  const padded = text.startsWith('0') ? radialFields(text, 4) : undefined;
  if (padded?.distance?.length === 3 && padded.radial <= 360) {
    return parsed({ radial: padded.radial % 360, distanceNm: Number(padded.distance), recovered: true });
  }
  return ordinary?.distance !== undefined || padded?.distance !== undefined ? reject('Location bearing or distance out of range') : noMatch;
}
