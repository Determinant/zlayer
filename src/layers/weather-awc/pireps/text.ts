import { PIREP_MAX_AGE_MS } from '@zlayer/contracts';

export type PirepField = 'OV' | 'TM' | 'FL' | 'TP' | 'SK' | 'WX' | 'TA' | 'WV' | 'TB' | 'IC';

/** FAA text-element indicators delimit whole fields; /RM starts terminal prose.
 * Keep repeated fields so each consumer can handle duplicates explicitly. */
export function readPirepFields(raw: string) {
  if (raw.length > 20_000) return;
  const text = raw.toUpperCase();
  const header = /^\s*(?:([A-Z0-9]{3,4})\s+)?(?:UUA|UA)\b\s*/.exec(text);
  if (!header) return;
  const fields: Partial<Record<PirepField, string[]>> = {};
  let state: PirepField | undefined, start = header[0].length;
  for (let cursor = start; cursor <= text.length; cursor++) {
    const marker = text[cursor] === '/' ? /^\/\s*(OV(?=\s|\d|$)|TM|FL|TP|SK(?!C)|WX|TA|WV|TB|IC|RM)/.exec(text.slice(cursor)) : null;
    if (cursor !== text.length && !marker) continue;
    if (state) (fields[state] ??= []).push(text.slice(start, cursor).trim());
    if (!marker || marker[1] === 'RM') break;
    state = marker[1] as PirepField;
    start = cursor + marker[0].length;
    cursor = start - 1;
  }
  return { station: header[1], fields };
}

/** Cloud-layer slashes and duplicate fields cannot supply a single value. */
export function readPirepField(raw: string, target: 'OV' | 'TM' | 'FL') {
  const report = readPirepFields(raw);
  if (!report || (report.fields[target]?.length ?? 0) > 1) return;
  return { station: report.station, value: report.fields[target]?.[0] };
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
