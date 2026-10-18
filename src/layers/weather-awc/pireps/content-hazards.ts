import { Cursor, numeric, feet, range, type Condition } from './content-tokens';

const frequencies: Record<string, string> = { CONS: 'CONT', CONT: 'CONT', CONTINUOUS: 'CONT', OCNL: 'OCNL', OCSNL: 'OCNL', INTMT: 'INTMT' };
const intensities: Record<string, string> = { NEG: 'NEG', NEGATIVE: 'NEG', NONE: 'NEG', SMOOTH: 'NEG', SMTH: 'NEG',
  TRACE: 'TRC', TRC: 'TRC', LGT: 'LGT', LIGHT: 'LGT', LT: 'LGT', LGHT: 'LGT', LEGT: 'LGT', MOD: 'MOD', MODERATE: 'MOD', SEV: 'SEV', SEVERE: 'SEV', EXTRM: 'EXTRM', EXTREME: 'EXTRM' };
const kinds: Record<string, string> = { CAT: 'CAT', CHOP: 'CHOP', RIME: 'RIME', CLR: 'CLEAR', CLEAR: 'CLEAR', MX: 'MIXED', MXD: 'MIXED', MIXED: 'MIXED' };

function hazardHeight(cursor: Cursor): string | undefined {
  let qualifier = cursor.take('ABV') || cursor.take('ABOVE') ? 'above' : cursor.take('BLO') || cursor.take('BELOW') ? 'below'
    : cursor.take('THRU') || cursor.take('THROUGH') ? 'through' : '';
  cursor.take('FL');
  const first = cursor.peek();
  if (!numeric(first)) return;
  cursor.position++;
  let value = String(feet(first));
  if (cursor.take('-')) {
    const second = cursor.peek();
    if (qualifier || !numeric(second)) return;
    cursor.position++;
    value = `${Math.min(feet(first), feet(second))}–${Math.max(feet(first), feet(second))}`;
  } else if (cursor.take('AND')) {
    if (qualifier) return;
    if (cursor.take('BLO') || cursor.take('BELOW')) qualifier = 'at or below';
    else if (cursor.take('ABV') || cursor.take('ABOVE')) qualifier = 'at or above';
    else return;
  } else if (!qualifier) value = `at ${value}`;
  return `${qualifier ? `${qualifier} ` : ''}${value} ft MSL${qualifier === 'through' ? ' (other bound unspecified)' : ''}`;
}

/** Frequency → intensity → type → altitude, with explicit clause transitions.
 * Frequency/intensity ranges belong to their own clause. An altitude is consumed
 * before the next intensity, so a later NEG cannot steal an earlier icing layer. */
export function parsePirepHazard(text: string, field: 'TB' | 'IC'): Condition | undefined {
  const cursor = new Cursor(text);
  if (!cursor.tokens.length || cursor.tokens.length > 512) return;
  const name = field === 'TB' ? 'Turbulence' : 'Icing';
  if (cursor.phrase('N', '/', 'A') && cursor.done) return { values: [], notes: [`${name} not reported (/${field} N/A)`] };
  cursor.position = 0;
  // A controller/source attribution in the condition slot supplies no weather.
  if (/^Z[A-Z]{2}(?:WC)?$/.test(cursor.peek() ?? '')) {
    cursor.position++; cursor.take('-');
    if (numeric(cursor.peek())) cursor.position++;
    if (cursor.done) return { values: [], notes: [`${name} not reported (/${field} contains attribution ${text})`] };
    return;
  }
  const output: string[] = [];
  const notes: string[] = [];
  let state: 'clause' | 'height' | 'end' = 'clause';
  let intensity = '', frequency = '', kind = '', height = '', motion = '', mentioned = false;
  const flush = () => {
    if (!intensity && !kind && !mentioned && !(frequency && height)) return false;
    output.push([[kind, intensity || 'Intensity unspecified', frequency].filter(Boolean).join(' '), [motion, height].filter(Boolean).join(' ')].filter(Boolean).join(' · '));
    intensity = frequency = kind = height = motion = ''; mentioned = false; return true;
  };
  while (true) {
    if (output.length > 100) return;
    switch (state) {
      case 'clause': {
        if (cursor.done) { state = 'end'; break; }
        const token = cursor.peek()!;
        if (token === '/') {
          // An ARTCC attribution is a terminal source marker, not a condition.
          if (/^Z[A-Z]{2}$/.test(cursor.peek(1) ?? '') && cursor.position + 2 === cursor.tokens.length) {
            cursor.position += 2; state = 'end'; break;
          }
          if (!flush()) return;
          cursor.position++; break;
        }
        if (token === '-') {
          if (!intensity || !(frequencies[cursor.peek(1) ?? ''] || kinds[cursor.peek(1) ?? ''])) return;
          cursor.position++; break;
        }
        // Compact frequency/intensity still has a defined boundary owned here.
        if (field === 'TB' && !frequencies[token] && !intensities[token]) {
          const prefix = Object.keys(frequencies).find(prefix => token.startsWith(prefix) && intensities[token.slice(prefix.length)]);
          if (prefix) { cursor.tokens.splice(cursor.position, 1, prefix, token.slice(prefix.length)); continue; }
        }
        if (frequencies[token]) {
          if (field !== 'TB') return;
          if (height || intensity && (frequency || intensities[cursor.peek(1) ?? ''])) { if (!flush()) return; }
          if (frequency) return;
          frequency = range(cursor, frequencies)!; break;
        }
        if (intensities[token]) {
          if (intensity && !flush()) return;
          const start = cursor.position;
          intensity = range(cursor, intensities)!;
          for (const original of cursor.tokens.slice(start, cursor.position)) if (['LGHT', 'LEGT'].includes(original)) {
            notes.push(`${name}: interpreted ${original} as LGT (assumed spelling correction)`);
          }
          break;
        }
        if (kinds[token]) {
          const value = kinds[token]!;
          if (field === 'TB' ? !['CAT', 'CHOP'].includes(value) : ['CAT', 'CHOP'].includes(value)) return;
          if (kind || height) return;
          kind = value; cursor.position++; break;
        }
        if (['TURB', 'TURBULENCE', 'ICE', 'ICING'].includes(token)) {
          if (mentioned || (field === 'TB') !== token.startsWith('TURB')) return;
          mentioned = true; cursor.position++; break;
        }
        if (cursor.phrase('SHORT', 'FINAL')) {
          if (motion || !intensity && !kind && !mentioned) return;
          motion = 'on short final'; break;
        }
        if (token === 'DURC' || token === 'DURD') {
          if (motion || height || !intensity) return;
          motion = token === 'DURC' ? 'during climb' : 'during descent'; cursor.position++; state = 'height'; break;
        }
        if (numeric(token) || ['FL', 'ABV', 'ABOVE', 'BLO', 'BELOW', 'THRU', 'THROUGH'].includes(token)) {
          if ((!intensity && !kind && !mentioned && !frequency) || height) return;
          state = 'height'; break;
        }
        return;
      }
      case 'height': {
        const parsed = hazardHeight(cursor);
        if (!parsed) return;
        height = parsed; state = 'clause'; break;
      }
      case 'end': return flush() ? { values: output, ...(notes.length ? { notes } : {}) } : undefined;
    }
  }
}
