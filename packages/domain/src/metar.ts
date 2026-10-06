import { weatherTokens, type WeatherSpan, type WeatherToken } from './weather-tokens.js';

type MetarSectionKind = 'observation' | 'trend' | 'remarks' | 'ended' | 'unparsed';
export type MetarSection = WeatherSpan & { kind: MetarSectionKind; tokens: readonly WeatherToken[] };

// Documented missing separators (NASA/TM-2014-218385, table 19). Recognize the
// section boundary without repairing or decoding the attached remark itself.
const remarksMarker = (value: string) => value === 'RMK' || value.startsWith('RMK/') || /^RMKAO[12]$/.test(value);

/** One-way section transitions prevent trends, remarks or a following report
 * from supplying an observation field. Unknown tokens stay in their source section. */
export function metarSections(raw: string): MetarSection[] {
  const tokens = weatherTokens(raw);
  if (!tokens) return [{ start: 0, end: raw.length, kind: 'unparsed', tokens: [] }];
  const sections: MetarSection[] = [];
  let state: MetarSectionKind = 'observation', start = 0, first = 0;
  const finish = (end: number, next: number) => {
    if (end > start) sections.push({ start, end, kind: state, tokens: tokens.slice(first, next) });
  };
  for (const [index, token] of tokens.entries()) {
    if (state === 'ended') break;
    const next: MetarSectionKind = token.value === '=' ? 'ended'
      : state !== 'remarks' && remarksMarker(token.value) ? 'remarks'
      : state === 'observation' && ['TEMPO', 'BECMG', 'NOSIG'].includes(token.value) ? 'trend' : state;
    if (next !== state) {
      finish(token.start, index);
      start = token.start; first = index; state = next;
    }
  }
  finish(raw.length, tokens.length);
  return sections;
}

export function metarObservationTokens(raw: string | undefined): readonly WeatherToken[] {
  return raw ? metarSections(raw).find(section => section.kind === 'observation')?.tokens ?? [] : [];
}

/** Extract a published pressure setting in its reported unit; formatting stays in the UI. */
export function metarAltimeter(raw: string | undefined): { amount: number; unit: 'inHg' | 'hPa'; source: WeatherSpan } | undefined {
  for (const token of metarObservationTokens(raw)) {
    const match = /^([AQ])(\d{4})$/.exec(token.value);
    if (!match) continue;
    const amount = Number(match[2]);
    if (!amount) return undefined;
    return { amount: match[1] === 'A' ? amount / 100 : amount, unit: match[1] === 'A' ? 'inHg' : 'hPa',
      source: { start: token.start, end: token.end } };
  }
  return undefined;
}
