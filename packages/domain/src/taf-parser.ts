import { weatherTokens, type WeatherSpan, type WeatherToken } from './weather-tokens.js';

export type TafGroupHeader =
  | { kind: 'initial' | 'remarks' | 'invalid' }
  | { kind: 'FM'; from: string; source: WeatherSpan }
  | { kind: 'BECMG' | 'TEMPO' | 'PROB'; from: string; to: string; probability?: number };
export type TafGroup = WeatherSpan & { header: TafGroupHeader; tokens: readonly WeatherToken[] };
export type ParsedTaf = { groups: TafGroup[]; complete: boolean; unavailable: boolean };

function changeMarker(tokens: readonly WeatherToken[], index: number): boolean {
  const value = tokens[index]!.value, next = tokens[index + 1]?.value ?? '';
  if (/^(?:FM|BECMG|TEMPO|INTER|PROB)(?:\d|$)/.test(value)) return true;
  // AVWX's regression corpus documents these damaged change markers. Recognize
  // them as invalid headers so a dropped change cannot color the prevailing line.
  // This is a bounded rejection list, not spelling correction of arbitrary words.
  return /^(?:BEC|BEMG|TEMP0|TEMP|TEMO)(?:\d|$)/.test(value)
    || value === 'BE' && /^CMG(?:\d|$)/.test(next)
    || value === 'T' && /^EMPO(?:\d|$)/.test(next);
}

/** Consume a whole change header before any of its weather can be interpreted.
 * PROB -> probability -> optional TEMPO/INTER -> period is one group. */
function changeHeader(raw: string, tokens: readonly WeatherToken[], start: number): { header: TafGroupHeader; next: number } {
  const marker = tokens[start]!;
  let next = start + 1;
  const invalid = () => ({ header: { kind: 'invalid' } as const, next });
  if (marker.value.startsWith('FM') && marker.value !== 'FM') {
    return /^FM\d{6}$/.test(marker.value)
      ? { header: { kind: 'FM', from: marker.value.slice(2), source: { start: marker.start, end: marker.end } }, next } : invalid();
  }
  if (!marker.value.startsWith('PROB') && !['FM', 'BECMG', 'TEMPO', 'INTER'].includes(marker.value)) return invalid();
  let state: 'fm-time' | 'probability' | 'qualifier' | 'period' = marker.value === 'FM' ? 'fm-time'
    : marker.value === 'PROB' ? 'probability' : marker.value.startsWith('PROB') ? 'qualifier' : 'period';
  let kind: 'BECMG' | 'TEMPO' | 'PROB' = marker.value === 'BECMG' ? 'BECMG'
    : marker.value.startsWith('PROB') ? 'PROB' : 'TEMPO';
  let probability: number | undefined;
  if (state === 'qualifier') {
    if (!/^PROB(?:30|40)$/.test(marker.value)) return invalid();
    probability = Number(marker.value.slice(4));
  }
  for (;;) {
    const token = tokens[next];
    if (!token) return invalid();
    switch (state) {
      case 'fm-time':
        return /^\d{6}$/.test(token.value)
          ? { header: { kind: 'FM', from: token.value, source: { start: marker.start, end: token.end } }, next: next + 1 }
          : invalid();
      case 'probability':
        if (!/^(?:30|40)$/.test(token.value)) return invalid();
        probability = Number(token.value); next++; state = 'qualifier';
        break;
      case 'qualifier':
        if (token.value === 'TEMPO' || token.value === 'INTER') { kind = 'TEMPO'; next++; }
        state = 'period';
        break;
      case 'period': {
        // A bounded lexical pattern accepts a wrapped DDHH / DDHH token. It
        // cannot consume an intervening weather token or another change marker.
        const period = /^(\d{4})\s*\/\s*(\d{4})(?=\s|=|$)/.exec(raw.slice(token.start));
        if (!period) return invalid();
        const end = token.start + period[0].length;
        while (tokens[next] && tokens[next]!.start < end) next++;
        return { header: { kind, from: period[1]!, to: period[2]!, ...(probability !== undefined ? { probability } : {}) }, next };
      }
    }
  }
}

/** Parse source groups independently of AWC decoding and category evaluation.
 * Remarks and the report terminator cannot transition back to forecast weather. */
export function parseTafGroups(raw: string): ParsedTaf {
  const fallback = (): ParsedTaf => ({ groups: raw.trim()
    ? [{ start: 0, end: raw.length, header: { kind: 'invalid' }, tokens: [] }] : [], complete: false, unavailable: false });
  const tokens = weatherTokens(raw);
  if (!tokens) return fallback();
  const groups: TafGroup[] = [];
  let state: 'forecast' | 'remarks' | 'ended' = 'forecast';
  let header: TafGroupHeader = { kind: 'initial' }, start = 0, bodyStart = 0, index = 0;
  let complete = true, unavailable = false;
  const finish = (end: number, next: number) => {
    if (!raw.slice(start, end).trim()) return;
    const body = tokens.slice(bodyStart, next);
    if (['FM', 'BECMG', 'TEMPO', 'PROB'].includes(header.kind) && !body.some(token => token.value !== '=')) complete = false;
    groups.push({ start, end, header, tokens: body });
  };
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (state === 'remarks') break;
    if (token.value === 'RMK') {
      finish(token.start, index);
      start = token.start; bodyStart = index; header = { kind: 'remarks' }; state = 'remarks';
    } else if (state === 'ended') {
      // Preserve any trailing text, but never use it as another forecast period.
      if (token.value !== '=') {
        finish(token.start, index);
        start = token.start; bodyStart = index; header = { kind: 'invalid' }; complete = false;
        break;
      }
      index++;
    } else if (token.value === '=') {
      state = 'ended'; index++;
    } else if (changeMarker(tokens, index)) {
      finish(token.start, index);
      if (groups.length >= 128) return fallback();
      const change = changeHeader(raw, tokens, index);
      start = token.start; header = change.header; bodyStart = change.next; index = change.next;
      if (header.kind === 'invalid') complete = false;
    } else {
      if (token.value === 'NIL' || token.value === 'CNL') unavailable = true;
      index++;
    }
  }
  finish(raw.length, tokens.length);
  return groups.length > 128 ? fallback() : { groups, complete, unavailable };
}
