import type { AwcAdvisoryClassification, AwcAdvisoryProduct, AwcClassificationFailure } from '@zlayer/contracts';

type Header = { convective: boolean; issuer: string; identifier: string; issued: string; until: string };
type Prefix = Pick<Header, 'convective' | 'issuer'>;
type Evidence = { kind: 'unsupported'; prefix?: Prefix } | { kind: 'invalid' } | { kind: 'header'; value: Header };
const unsupported: Evidence = { kind: 'unsupported' }, invalid: Evidence = { kind: 'invalid' };
const series = (value: string) => value.replace(/^0+(?=\d)/, '');

/** Read only ordered domestic SIGMET header lines. Body/outlook words cannot
 * supply a category, and a second active bulletin cannot lend its identity. */
function domesticHeader(raw: unknown): Evidence {
  if (typeof raw !== 'string' || !raw.trim()) return unsupported;
  if (raw.length > 100_000) return invalid;
  const lines = raw.split(/\r?\n/).map(line => line.trim().replace(/[ \t]+/g, ' ')).filter(Boolean);
  if (lines.length > 2048 || lines.some(line => line.length > 4096)) return invalid;
  const wmo = /^WSUS(0[1-6]|3[1-3]) ([A-Z]{4}) (\d{6})(?: (?:CC|AA|RR)[A-Z])?$/.exec(lines[0] ?? '');
  if (!wmo) return unsupported;
  const convective = wmo[1]!.startsWith('3'), region = ({ '31': 'E', '32': 'C', '33': 'W' } as Record<string, string>)[wmo[1]!];
  const unrecognized: Evidence = { kind: 'unsupported', prefix: { convective, issuer: wmo[2]! } };
  // Control messages and multiple active bulletins are contradictions even when
  // another header line uses unsupported syntax. Outlook references are separate.
  let headings = 0;
  for (const line of lines.slice(1)) {
    if (/^OUTLOOK\b/.test(line)) break;
    if (/\bCANCEL(?:LED)?\b/.test(line) || /^CONVECTIVE SIGMET[ .]+NONE\b/.test(line) || /^WSUS\d\d\b/.test(line)) return invalid;
    if (/^(?:CONVECTIVE SIGMET|SIGMET)\b/.test(line) && ++headings > 1) return invalid;
  }
  let at = 1;
  const awips = /^(?:MKC)?(?:SIG([ECW])|WS([1-6])[A-Z])$/.exec(lines[at] ?? '');
  if (awips) {
    if (convective ? awips[1] !== region : awips[2] !== wmo[1]![1]) return invalid;
    at++;
  }
  const office = /^([A-Z]{4}) (WST|WS) (\d{6})(?: COR)?$/.exec(lines[at] ?? '');
  if (office) {
    if (office[2] !== (convective ? 'WST' : 'WS') || office[3] !== wmo[3] ||
      (convective && office[1] !== `MKC${region}`)) return invalid;
    at++;
  }
  let identifier: string, until: string;
  if (convective) {
    const headingLine = lines[at++] ?? '';
    if (/^SIGMET\b/.test(headingLine)) return invalid;
    const heading = /^CONVECTIVE SIGMET (\d{1,3}[ECW])(?: (?:COR|AMD))?$/.exec(headingLine);
    const validity = /^VALID UNTIL (\d{4})Z$/.exec(lines[at++] ?? '');
    if (heading && !heading[1]!.endsWith(region!)) return invalid;
    if (!heading || !validity) return unrecognized;
    identifier = heading[1]!; until = validity[1]!;
  } else {
    const headingLine = lines[at++] ?? '';
    if (/^CONVECTIVE SIGMET\b/.test(headingLine)) return invalid;
    const heading = /^SIGMET ([A-Z]{3,10}) (\d{1,3}) VALID UNTIL (\d{6})(?: [A-Z ]+)?$/.exec(headingLine);
    if (!heading) return unrecognized;
    identifier = `${heading[1]} ${heading[2]}`; until = heading[3]!;
  }
  let body = false;
  for (; at < lines.length; at++) {
    const line = lines[at]!;
    if (/^OUTLOOK\b/.test(line)) break;
    if (line !== '.' && line !== '....') body = true;
  }
  return body ? { kind: 'header', value: { convective, issuer: wmo[2]!, identifier, issued: wmo[3]!, until } } : invalid;
}

/** Resolve DDHHMM against adjacent calendar months, including year rollover.
 * Validate the calendar rather than accepting Date's normalized invalid dates. */
function dates(code: string, reference: number): number[] {
  const day = Number(code.slice(0, 2)), hour = Number(code.slice(2, 4)), minute = Number(code.slice(4));
  if (day < 1 || day > 31 || hour > 23 || minute > 59) return [];
  const around = new Date(reference), result: number[] = [];
  for (const offset of [-1, 0, 1]) {
    const date = new Date(Date.UTC(around.getUTCFullYear(), around.getUTCMonth() + offset, day, hour, minute));
    if (date.getUTCDate() === day) result.push(+date);
  }
  return result;
}
type ValidityEvidence = { kind: 'matched'; sourceDurationMs?: number } | { kind: 'unsupported' | 'conflict' };
function validityEvidence(header: Header, from: number, to: number, suppliedHazard: boolean): ValidityEvidence {
  const nominal = (header.convective ? 2 : 4) * 3_600_000;
  // Acquisition bound, not a declaration that an atypical domestic period
  // conforms to publication guidance. Six hours covers the longest SIGMET
  // product period without borrowing a same-number notice from another day.
  const maximum = 6 * 3_600_000;
  let coherent = false;
  for (const start of dates(header.issued, from)) {
    if (from < start || from >= start + maximum) continue;
    const ends = header.until.length === 6 ? dates(header.until, start) : (() => {
      const hour = Number(header.until.slice(0, 2)), minute = Number(header.until.slice(2));
      if (hour > 23 || minute > 59) return [];
      const end = new Date(start); end.setUTCHours(hour, minute, 0, 0);
      if (+end <= start) end.setUTCDate(end.getUTCDate() + 1);
      return [+end];
    })();
    // AWC may clip effective validity when replacing a bulletin. It may not
    // extend beyond the bulletin or borrow a same-number notice from another day.
    for (const end of ends) {
      if (end <= start || from >= end || from >= to || to > end) continue;
      const duration = end - start;
      if (duration <= nominal) return { kind: 'matched' };
      coherent = true;
      // A complete supplied category and exact source interval are stronger
      // evidence than an expected issuance duration. Never infer a missing
      // category or supplement clipped times through this exceptional path.
      if (duration <= maximum && suppliedHazard && from === start && to === end)
        return { kind: 'matched', sourceDurationMs: duration };
    }
  }
  return { kind: coherent ? 'unsupported' : 'conflict' };
}

type Resolution = { kind: 'resolved'; hazard: string; classification: AwcAdvisoryClassification }
  | { kind: 'issue'; detail: AwcClassificationFailure };
const issue = (detail: AwcClassificationFailure): Resolution => ({ kind: 'issue', detail });
const resolved = (hazard: string, basis: AwcAdvisoryClassification['basis'],
  bulletin?: AwcAdvisoryClassification['bulletin']): Resolution =>
  ({ kind: 'resolved', hazard, classification: { basis, ...(bulletin ? { bulletin } : {}) } });

/** Resolve evidence rather than treating parser support as source validity.
 * Unknown syntax can neither repair missing metadata nor contradict supplied
 * metadata. Recognized contradictions remain blocking in either path. */
export function advisorySourceHazard(product: AwcAdvisoryProduct, properties: Record<string, unknown>,
  validFrom: number, validTo: number | null): Resolution {
  const supplied = properties.hazard;
  if (supplied != null && (typeof supplied !== 'string' || !supplied.trim())) return issue('malformed-hazard');
  const hazard = typeof supplied === 'string' ? supplied.trim() : null;
  if (product === 'cwa') return resolved(hazard ?? 'UNK', hazard ? 'metadata' : 'unspecified');
  if (product === 'gairmet') return hazard ? resolved(hazard, 'metadata') : issue('missing-hazard');
  const evidence = domesticHeader(properties.rawAirSigmet);
  if (evidence.kind === 'invalid') return issue('malformed-bulletin');
  const prefix = evidence.kind === 'header' ? evidence.value : evidence.prefix;
  if (prefix) {
    if (typeof properties.airSigmetType !== 'string' || properties.airSigmetType.trim() !== 'SIGMET' || typeof properties.icaoId !== 'string' ||
      properties.icaoId.trim() !== prefix.issuer) return issue('identity-conflict');
    if (hazard && (hazard === 'CONVECTIVE') !== prefix.convective) return issue('category-conflict');
  }
  if (evidence.kind === 'unsupported') return hazard ? resolved(hazard, 'metadata', 'unsupported') : issue('unsupported-bulletin');
  const header = evidence.value;
  if (typeof properties.seriesId !== 'string' || series(properties.seriesId.trim()) !== series(header.identifier)) return issue('identity-conflict');
  if (validTo === null) return issue('validity-conflict');
  const validity = validityEvidence(header, validFrom, validTo, hazard !== null);
  if (validity.kind !== 'matched') return issue(validity.kind === 'conflict' ? 'validity-conflict' : 'unsupported-bulletin');
  // A non-convective header proves the display category, not its meteorological
  // hazard. Preserve that uncertainty instead of guessing from body keywords.
  const result = resolved(hazard ?? (header.convective ? 'CONVECTIVE' : 'UNK'),
    hazard ? 'metadata' : header.convective ? 'bulletin' : 'unspecified', 'matched');
  if (validity.sourceDurationMs !== undefined && result.kind === 'resolved') result.classification.sourceDurationMs = validity.sourceDurationMs;
  return result;
}
