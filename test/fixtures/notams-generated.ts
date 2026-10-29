import type { NotamRecord } from '@zlayer/contracts';
import { recordWithRevision } from '../../tools/info-server/notams/normalize';
import { notice } from './notams';
import { faaKeywords } from './notams-local-grammar';

// Invented grammar examples, independent of captured notices and parser output.
// FAA JO 7930.2U §1-2-1 supplies the keywords; §8-1-2 supplies Q/A/B/C/D/E/F/G
// roles. The station/FIR reconciliation and omission expectations are project
// policies in source-comparison.md, not additional FAA format requirements.
export const generatedNotamSeed = 0x79302;
export function notamRandom(seed: number) {
  let state = seed;
  return (limit: number) => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) % limit;
  };
}
export function changeGeneratedNotam(record: NotamRecord, fields: Partial<NotamRecord>): NotamRecord {
  const { revision: _revision, ...facts } = record;
  return recordWithRevision({ ...facts, ...fields });
}

export function* generatedNotams() {
  let index = 0;
  for (const keyword of faaKeywords) for (const end of ['fixed', 'estimated', 'permanent'] as const)
    for (const schedule of ['', 'DLY 1200-1400']) {
      const seed = generatedNotamSeed + index, random = notamRandom(seed);
      const pick = <T>(values: readonly T[]) => values[random(values.length)]!;
      const station = pick(['ABC', 'A1B', 'ABCD', 'XYZ']), fir = pick(['KZLA', 'PAZA', 'EGTT', 'YBBB']);
      const number = String(1 + random(9999)), series = pick(['A', 'B', 'C']);
      const body = `${keyword} TEST CONTENT ${random(999)}. ALL LIMITS & RESTRICTIONS APPLY.`;
      const text = `${station} ${body}`, start = '2610041159';
      const until = end === 'permanent' ? 'PERM' : `2610051200${end === 'estimated' ? 'EST' : ''}`;
      const limits = keyword === 'AIRSPACE' ? ' F) SFC G) FL180' : '';
      const icao = `${series}${number.padStart(4, '0')}/26 NOTAMN ` +
        `Q) ${fir}/QXXXX/IV/BO/${keyword === 'AIRSPACE' ? 'W' : 'AE'}/000/999/3500N12000W005 ` +
        `A) ${fir} B) ${start} C) ${until} ${schedule ? `D) ${schedule} ` : ''}E) ${text}${limits}`;
      const local = `!TST 10/${number.padStart(3, '0')} ${station} ${body} ${start}-${until}`;
      const full = changeGeneratedNotam(notice(), {
        id: String(1800000000000000 + index), sourceId: `NMS_ID_${1800000000000000 + index}`,
        classification: pick(['INTL', 'MIL']), number, series, locations: [station], icaoLocations: [fir], accountability: fir,
        text, schedule, endKind: end, effectiveEnd: end === 'permanent' ? 'PERM' : '202610051200',
        endsAt: end === 'permanent' ? null : Date.parse('2026-10-05T12:00:00Z'),
        translations: [{ type: 'OTHER:ICAO', text: icao }, ...(random(2) ? [{ type: 'LOCAL_FORMAT', text: local }] : [])],
      });
      // Independently vary lexical forms and optional structured metadata. The
      // complete FIR-associated notice always supplies the missing evidence.
      const format = pick(['compact', 'wrapped', 'multiline']);
      const render = (value: string) => format === 'compact' ? value.replace(/([QABCDEFG]\)) /g, '$1')
        : format === 'wrapped' ? `<pre>\n${value.replaceAll('&', '&amp;').replaceAll(' ', '\n  ')}\n</pre>`
        : value.replaceAll(' ', '\r\n  ');
      const alternate = changeGeneratedNotam(full, {
        icaoLocations: [station], number: number.padStart(5, '0'), year: random(2) ? '' : full.year,
        schedule: random(2) ? '' : schedule, sequence: 1 + random(4), correction: random(3),
        effectiveStart: new Date(full.startsAt!).toISOString(),
        effectiveEnd: full.endsAt === null ? 'PERM' : new Date(full.endsAt).toISOString(),
        // The ICAO witness owns decoded ICAO equivalence. A separately numbered
        // local rendering on INTL/MIL has no native-identity decoding authority;
        // retain its literal entities (that limit has a negative regression).
        translations: full.translations.map(t => ({ ...t, text: t.type === 'OTHER:ICAO' ? render(t.text) : t.text.replaceAll(' ', '\n  ') })),
      });
      const sparse = changeGeneratedNotam(full, { translations: [], icaoLocations: [] });
      yield { index: index++, seed, keyword, end, schedule, station, fir, format, full, alternate, sparse };
    }
}
