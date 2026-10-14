import { PIREP_MAX_AGE_MS } from '@zlayer/contracts';

/** FAA text-element indicators delimit whole fields; /RM starts terminal prose.
 * Cloud-layer slashes and duplicate fields cannot supply an interpreted value. */
export function readPirepField(raw: string, target: 'OV' | 'TM' | 'FL') {
  if (raw.length > 20_000) return;
  const text = raw.toUpperCase();
  const header = /^\s*(?:([A-Z0-9]{3,4})\s+)?(?:UUA|UA)\b\s*/.exec(text);
  if (!header) return;
  let state = '', start = header[0].length, value: string | undefined;
  for (let cursor = start; cursor <= text.length; cursor++) {
    const marker = text[cursor] === '/' ? /^\/\s*(OV(?=\s|\d|$)|TM|FL|TP|SK|WX|TA|WV|TB|IC|RM)/.exec(text.slice(cursor)) : null;
    if (cursor !== text.length && !marker) continue;
    if (state === target) {
      if (value !== undefined) return;
      value = text.slice(start, cursor).trim();
    }
    if (!marker || marker[1] === 'RM') break;
    state = marker[1]!;
    start = cursor + marker[0].length;
    cursor = start - 1;
  }
  return { station: header[1], value };
}

/** /TM supplies HHMM UTC, without a date. Recover only the unique occurrence
 * within the source publication's 90-minute window, including across midnight.
 * The device clock and conflicting receipt/default observation times cannot
 * re-date a cached report or make an old/future time current. */
export function readPirepTime(raw: string, checkedAt: number): number | undefined {
  const value = readPirepField(raw, 'TM')?.value;
  if (!value || !/^(?:[01]\d|2[0-3])[0-5]\d$/.test(value)) return;
  const day = 86_400_000;
  let time = Math.floor(checkedAt / day) * day + (Number(value.slice(0, 2)) * 60 + Number(value.slice(2))) * 60_000;
  if (time > checkedAt) time -= day;
  return time > 0 && checkedAt - time < PIREP_MAX_AGE_MS ? time : undefined;
}
