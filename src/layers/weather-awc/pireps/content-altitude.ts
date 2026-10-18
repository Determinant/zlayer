import { Cursor, feet, numeric } from './content-tokens';

export type ReportedAltitude =
  | { kind: 'single'; feet: number }
  | { kind: 'unspecified'; reason?: string }
  | { kind: 'units-unknown'; value: string }
  | { kind: 'range'; low: number; high?: number }
  | { kind: 'qualified'; feet: number; qualifier: string }
  | { kind: 'unsupported' };

/** Value → endpoint → units → end. A four-digit value without explicit units
 * is retained as a number with unknown scale, never guessed to be feet or FL. */
export function readPirepAltitude(text: string): ReportedAltitude {
  const cursor = new Cursor(text);
  if (!cursor.tokens.length || cursor.tokens.length > 16) return { kind: 'unsupported' };
  if (cursor.tokens.length === 1) {
    if (['DURC', 'DURD', 'UNKN', 'UNK'].includes(cursor.peek()!)) return { kind: 'unspecified' };
    if (cursor.peek() === 'VFR') return { kind: 'unspecified', reason: 'VFR supplies flight conditions, not a height' };
    if (cursor.peek() === 'DURA') return { kind: 'unspecified', reason: 'nonstandard token DURA supplies no height' };
  }
  let state: 'value' | 'endpoint' | 'units' | 'end' = 'value';
  let first = '', second: string | undefined, interval = false, explicitFeet = false, qualifier = '';
  while (true) switch (state) {
    case 'value': {
      qualifier = cursor.take('ABV') || cursor.take('ABOVE') ? 'above' : cursor.take('BLO') || cursor.take('BELOW') ? 'below' : '';
      cursor.take('FL');
      const value = cursor.peek();
      if (!value || !/^\d{1,6}$/.test(value)) return { kind: 'unsupported' };
      first = value; cursor.position++;
      if (cursor.take('-')) { interval = true; state = 'endpoint'; }
      else state = 'units';
      break;
    }
    case 'endpoint': {
      if (cursor.done) { state = 'end'; break; }
      const value = cursor.peek();
      if (!value || !/^\d{1,6}$/.test(value)) return { kind: 'unsupported' };
      second = value; cursor.position++; state = 'units'; break;
    }
    case 'units': {
      explicitFeet = cursor.take('FT') || cursor.take('FEET');
      if (cursor.take('AGL')) qualifier = qualifier ? `${qualifier}, AGL` : 'AGL';
      else cursor.take('MSL');
      state = 'end'; break;
    }
    case 'end': {
      if (!cursor.done || interval && qualifier) return { kind: 'unsupported' };
      if (!explicitFeet && (!numeric(first) || second !== undefined && !numeric(second))) {
        return { kind: 'units-unknown', value: text };
      }
      const low = explicitFeet ? Number(first) : feet(first), high = second === undefined ? undefined : explicitFeet ? Number(second) : feet(second);
      if (low > 100_000 || high !== undefined && high > 100_000) return { kind: 'unsupported' };
      if (interval) return { kind: 'range', low, ...(high === undefined ? {} : { high }) };
      if (qualifier) return { kind: 'qualified', feet: low, qualifier };
      return { kind: 'single', feet: low };
    }
  }
}
