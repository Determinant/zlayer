/** Lossless lexical evidence for source comparison. Values are comparison views;
 * token spans always address the original string, including escaped characters. */
export type RepresentationToken = { value: string; start: number; end: number };
export type Representation = { source: string; tokens: RepresentationToken[]; text: string;
  changes: ('pre-wrapper' | 'entities' | 'whitespace')[] };
export type RepresentationFailure = 'limit' | 'header' | 'field-order' | 'interval' | 'multipart' | 'body';
export type RepresentationResult<T> = { ok: true; value: T } | { ok: false; reason: RepresentationFailure };
const fail = (reason: RepresentationFailure): { ok: false; reason: RepresentationFailure } => ({ ok: false, reason });
const entities: Record<string, string> = { apos: "'", quot: '"', amp: '&', lt: '<', gt: '>' };

/** Decode exactly one recognized XML character-reference layer. Unknown entities
 * remain literal. Callers must establish complete notice evidence before using
 * decoded text to reconcile records; this is never a source rewrite. */
function decodeEntities(value: string): string {
  return value.replace(/&(?:apos|quot|amp|lt|gt|#\d{1,7}|#x[\da-fA-F]{1,6});/g, entity => {
    const name = entity.slice(1, -1);
    if (entities[name]) return entities[name]!;
    const code = name.startsWith('#x') ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
    // Whitespace/control references do not establish token boundaries here.
    return code >= 0x20 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) &&
      code !== 0xfffe && code !== 0xffff && !/\s/.test(String.fromCodePoint(code)) ? String.fromCodePoint(code) : entity;
  });
}

export function noticeRepresentation(source: string, formatted = false, decode = true): Representation | undefined {
  if (source.length > 256 * 1024) return;
  let start = source.length - source.trimStart().length, end = source.trimEnd().length;
  const changes: Representation['changes'] = [];
  if (formatted && source.slice(start, start + 5).toLowerCase() === '<pre>' && source.slice(end - 6, end).toLowerCase() === '</pre>') {
    start += 5; end -= 6; changes.push('pre-wrapper');
  }
  const tokens: RepresentationToken[] = [];
  for (const match of source.slice(start, end).matchAll(/\S+/g)) {
    if (tokens.length >= 32768) return;
    const value = decode ? decodeEntities(match[0]) : match[0];
    if (value !== match[0] && !changes.includes('entities')) changes.push('entities');
    tokens.push({ value, start: start + match.index, end: start + match.index + match[0].length });
  }
  const text = tokens.map(token => token.value).join(' ');
  if (tokens.map(token => source.slice(token.start, token.end)).join(' ') !== source.slice(start, end)) changes.push('whitespace');
  return { source, tokens, text, changes };
}

export type BodySegment = { text: string; start: number; end: number };
export type IcaoNotice = { format: 'icao'; identity: string; change: 'N' | 'R' | 'C'; reference: string;
  q: string[]; locations: string[]; start: string; end: string; schedule: string;
  body: string; lower: string; upper: string; segments: BodySegment[]; representation: Representation };
export type IcaoContent = Omit<IcaoNotice, 'segments' | 'representation'>;
export type LocalNotice = { format: 'local'; office: string; number: string; location: string; subject: string;
  start: string; end: string; body: string; segments: BodySegment[]; representation: Representation };
const identity = /^(?:[A-Z]\d{4}\/\d{2}|\d{2}\/\d{3})$/;
const startTime = /^\d{10}$/;
const endTime = /^(?:\d{10}(?:EST)?|PERM)$/;
const location = /^[A-Z0-9]{2,8}$/;
const fieldMarker = /^[A-GQ]\)$/;
const subjects = new Set(['IAP', 'SID', 'STAR', 'ODP', 'ROUTE', 'VFP', 'SPECIAL']);

class Cursor {
  position = 0;
  private readonly tokens: RepresentationToken[];
  constructor(readonly representation: Representation) { this.tokens = [...representation.tokens]; }
  peek(ahead = 0) { return this.tokens[this.position + ahead]?.value; }
  take(value: string) { if (this.peek() !== value) return false; this.position++; return true; }
  atField(marker?: string) {
    const value = this.peek() ?? '';
    return marker ? value.startsWith(marker) : /^[A-GQ]\)/.test(value);
  }
  /** Only the field state may consume a compact marker. Keep the lexical view
   * unchanged, and retain a remainder spanning the original (possibly escaped)
   * source rather than inserting whitespace or splitting body prose globally. */
  takeField(marker: string) {
    if (!this.atField(marker)) return false;
    if (this.take(marker)) return true;
    const token = this.tokens[this.position]!, source = this.representation.source;
    let end = token.start + marker.length;
    while (end < token.end && decodeEntities(source.slice(token.start, end)) !== marker) end++;
    this.tokens[this.position] = { value: token.value.slice(marker.length), start: end, end: token.end };
    return true;
  }
  word(pattern: RegExp) {
    const word = this.peek(); if (word === undefined || !pattern.test(word)) return;
    this.position++; return word;
  }
  get done() { return this.position === this.tokens.length; }
  segment(from: number, to = this.position): BodySegment | undefined {
    const tokens = this.tokens.slice(from, to);
    if (!tokens.length) return;
    return { text: tokens.map(token => token.value).join(' '), start: tokens[0]!.start, end: tokens.at(-1)!.end };
  }
  part() {
    if (!this.take('PART')) return;
    const number = this.word(/^\d{1,2}$/);
    if (!number || !this.take('OF')) return;
    const total = this.word(/^\d{1,2}$/);
    if (!total || Number(number) < 1 || Number(total) < Number(number) || Number(total) > 32) return;
    return { number: Number(number), total: Number(total) };
  }
}
type IcaoPart = Omit<IcaoNotice, 'format' | 'representation'> & { part?: { number: number; total: number } };
type IcaoFields = Omit<IcaoPart, 'identity' | 'change' | 'reference'>;
const fieldsKey = (notice: IcaoPart | IcaoContent) => JSON.stringify([notice.identity, notice.change, notice.reference,
  notice.q, notice.locations, notice.start, notice.end, notice.schedule, notice.lower, notice.upper]);
export const icaoContentKey = (notice: IcaoContent) => JSON.stringify([fieldsKey(notice), notice.body]);

/** Parse one complete closure statement. Mapping its subject to a Q code belongs
 * to qualification policy; exceptions and additional instructions are not this
 * grammar. Never infer a closure from a recognized prefix alone. */
export function surfaceClosureSubject(body: string): 'AD' | 'APRON' | 'RWY' | 'TWY' | undefined {
  const representation = noticeRepresentation(body, false, false);
  if (!representation) return;
  const cursor = new Cursor(representation), subject = cursor.peek();
  if (subject !== 'AD' && subject !== 'APRON' && subject !== 'RWY' && subject !== 'TWY') return;
  cursor.position++;
  if (subject === 'RWY' && !cursor.word(/^(?:0[1-9]|[12]\d|3[0-6])[LCR]?(?:\/(?:0[1-9]|[12]\d|3[0-6])[LCR]?)?$/)) return;
  // Keep the automatic proof to short designators: accepting an arbitrary word
  // here would misread qualifiers such as PARTLY or TEMPO as a facility name.
  if (subject === 'TWY' && !cursor.word(/^[A-Z]{1,2}\d{0,2}$/)) return;
  if (subject === 'APRON' && cursor.peek() !== 'CLSD' && !cursor.word(/^(?:[A-Z]\d{0,2}|\d{1,2})$/)) return;
  if (!cursor.take('CLSD')) return;
  if (!cursor.done && !(cursor.take('DUE') && cursor.take('TO') && cursor.take('WIP'))) return;
  if (!cursor.done) return;
  return subject;
}

/** A field marker is meaningful only in its expected state. Every transition
 * consumes input; complete multipart order/identity is checked by the owner. */
function icaoPart(cursor: Cursor, allowMissingEnd: boolean): RepresentationResult<IcaoPart> {
  const id = cursor.word(identity), change = cursor.word(/^NOTAM[NRC]$/)?.slice(-1) as IcaoPart['change'] | undefined;
  if (!id || !change) return fail('header');
  const reference = change === 'N' ? '' : cursor.word(identity);
  if (reference === undefined) return fail('header');
  const fields = icaoFields(cursor, allowMissingEnd);
  return fields.ok ? { ok: true, value: { ...fields.value, identity: id, change, reference } } : fields;
}

function icaoFields(cursor: Cursor, allowMissingEnd: boolean): RepresentationResult<IcaoFields> {
  let state: 'q' | 'locations' | 'start' | 'end' | 'schedule' | 'body' | 'lower' | 'upper' | 'done' = 'q';
  const result: IcaoFields = { q: [], locations: [], start: '', end: '',
    schedule: '', body: '', lower: '', upper: '', segments: [] };
  while (state !== 'done') {
    switch (state) {
      case 'q': {
        if (!cursor.takeField('Q)')) return fail('field-order');
        const q = cursor.word(/^[A-Z0-9/]+$/)?.split('/');
        if (!q || q.length !== 8) return fail('header');
        result.q = q; state = 'locations'; break;
      }
      case 'locations': {
        if (!cursor.takeField('A)')) return fail('field-order');
        while (!cursor.atField('B)') && cursor.peek() !== 'PART') {
          const code = cursor.word(location);
          if (!code || result.locations.includes(code) || result.locations.length >= 32) return fail('header');
          result.locations.push(code);
        }
        if (!result.locations.length) return fail('header');
        if (cursor.peek() === 'PART') {
          const part = cursor.part(); if (!part) return fail('multipart');
          result.part = part;
        }
        state = 'start'; break;
      }
      case 'start':
        if (!cursor.takeField('B)')) return fail('field-order');
        result.start = cursor.word(startTime) ?? '';
        if (!result.start) return fail('interval');
        state = 'end'; break;
      case 'end':
        if (allowMissingEnd && (cursor.atField('D)') || cursor.atField('E)'))) {
          state = cursor.atField('D)') ? 'schedule' : 'body'; break;
        }
        if (!cursor.takeField('C)')) return fail('field-order');
        result.end = cursor.word(endTime) ?? '';
        if (!result.end) return fail('interval');
        state = cursor.atField('D)') ? 'schedule' : 'body'; break;
      case 'schedule': {
        cursor.takeField('D)'); const from = cursor.position;
        while (!cursor.done && !cursor.atField()) cursor.position++;
        result.schedule = cursor.segment(from)?.text ?? '';
        if (!result.schedule || !cursor.atField('E)')) return fail('field-order');
        state = 'body'; break;
      }
      case 'body':
      case 'lower':
      case 'upper': {
        const field = state, marker = field === 'body' ? 'E)' : field === 'lower' ? 'F)' : 'G)';
        if (!cursor.takeField(marker)) return fail('field-order');
        const from = cursor.position;
        while (!cursor.done && !fieldMarker.test(cursor.peek()!) && !cursor.atField('F)') && !cursor.atField('G)') &&
          !(cursor.peek() === 'END' && cursor.peek(1) === 'PART')) {
          if (cursor.peek() === 'PART' && /^\d+$/.test(cursor.peek(1) ?? '') && cursor.peek(2) === 'OF' ||
            identity.test(cursor.peek()!) && /^NOTAM[NRC]$/.test(cursor.peek(1) ?? '')) return fail('multipart');
          cursor.position++;
        }
        const segment = cursor.segment(from);
        if (!segment) return fail('body');
        result[field] = segment.text;
        if (field === 'body') result.segments.push(segment);
        if (field === 'body' && cursor.atField('F)')) state = 'lower';
        else if ((field === 'body' || field === 'lower') && cursor.atField('G)')) state = 'upper';
        else if (cursor.peek() === 'END' && cursor.peek(1) === 'PART') {
          cursor.take('END'); const closing = cursor.part();
          if (!closing || !result.part || closing.number !== result.part.number || closing.total !== result.part.total) return fail('multipart');
          state = 'done';
        } else {
          if (!cursor.done || result.part) return fail(result.part ? 'multipart' : 'field-order');
          state = 'done';
        }
        break;
      }
    }
  }
  return { ok: true, value: result };
}

/** FDC conversions may start at Q), without an ICAO notice number. This is
 * field evidence only: callers must bind it to a complete native notice. */
export function parseFdcIcaoFields(source: string): RepresentationResult<Omit<IcaoFields, 'part'> & { representation: Representation }> {
  const representation = noticeRepresentation(source, true);
  if (!representation) return fail('limit');
  const cursor = new Cursor(representation), result = icaoFields(cursor, false);
  if (!result.ok) return result;
  if (!cursor.done || result.value.part) return fail('multipart');
  const qualifiers = [/^[A-Z]{4}$/, /^Q[A-Z]{4}$/, /^(?:I|V|IV)$/, /^[NBOMK]{1,3}$/, /^[AEW]{1,3}$/,
    /^\d{3}$/, /^\d{3}$/, /^\d{4}[NS]\d{5}[EW]\d{3}$/];
  if (!qualifiers.every((pattern, index) => pattern.test(result.value.q[index]!))) return fail('header');
  const { part: _part, ...fields } = result.value;
  return { ok: true, value: { ...fields, representation } };
}

export function parseIcaoNotice(source: string, options: { allowMissingEnd?: boolean } = {}): RepresentationResult<IcaoNotice> {
  const representation = noticeRepresentation(source, true);
  if (!representation) return fail('limit');
  const cursor = new Cursor(representation), parts = new Map<number, IcaoPart>();
  let first: IcaoPart | undefined;
  do {
    if (parts.size >= 32) return fail('limit');
    const parsed = icaoPart(cursor, options.allowMissingEnd ?? false); if (!parsed.ok) return parsed;
    const part = parsed.value, number = part.part?.number ?? 1;
    if (parts.has(number) || first && (!part.part || !first.part || part.part.total !== first.part.total || fieldsKey(part) !== fieldsKey(first))) return fail('multipart');
    first ??= part; parts.set(number, part);
    if (!part.part && !cursor.done) return fail('multipart');
  } while (!cursor.done);
  const total = first.part?.total ?? 1;
  if (parts.size !== total) return fail('multipart');
  const ordered = Array.from({ length: total }, (_, index) => parts.get(index + 1));
  if (ordered.some(part => !part)) return fail('multipart');
  const { part: _part, ...notice } = first;
  return { ok: true, value: { ...notice, format: 'icao', representation,
    body: ordered.map(part => part!.body).join(' '), segments: ordered.flatMap(part => part!.segments) } };
}

/** Local envelopes own their leading identity and one terminal interval. Body
 * prose, including repeated headings, is never removed or interpreted here. */
export function parseLocalNotice(source: string): RepresentationResult<LocalNotice> {
  const representation = noticeRepresentation(source, true);
  if (!representation) return fail('limit');
  const cursor = new Cursor(representation);
  let state: 'office' | 'number' | 'location' | 'subject' | 'body' | 'done' = 'office';
  const result: LocalNotice = { format: 'local', office: '', number: '', location: '', subject: '', start: '', end: '', body: '', segments: [], representation };
  while (state !== 'done') {
    switch (state) {
      case 'office':
        result.office = cursor.word(/^![A-Z0-9]{1,8}$/)?.slice(1) ?? '';
        if (!result.office) return fail('header');
        state = 'number'; break;
      case 'number':
        result.number = cursor.word(result.office === 'FDC' ? /^\d\/\d{4}$/ : /^(?:\d{2}\/\d+|[A-Z]\d{4}\/\d{2})$/) ?? '';
        if (!result.number) return fail('header');
        state = 'location'; break;
      case 'location':
        result.location = cursor.word(/^[A-Z0-9]{3,5}$/) ?? '';
        if (!result.location) return fail('header');
        state = result.office === 'FDC' ? 'subject' : 'body'; break;
      case 'subject':
        if (!subjects.has(cursor.peek() ?? '')) return fail('header');
        result.subject = cursor.peek()!; cursor.position++; state = 'body'; break;
      case 'body': {
        const from = cursor.position, last = representation.tokens.length - 1;
        const interval = representation.tokens[last]?.value.split('-');
        if (!interval || interval.length !== 2 || !startTime.test(interval[0]!) || !endTime.test(interval[1]!)) return fail('interval');
        const segment = cursor.segment(from, last);
        if (!segment) return fail('body');
        // Multipart local notices need a separately qualified assembly grammar.
        if (representation.tokens.slice(from, last).some((token, i, tokens) => token.value === 'PART' &&
          /^\d+$/.test(tokens[i + 1]?.value ?? '') && tokens[i + 2]?.value === 'OF')) return fail('multipart');
        result.start = interval[0]!; result.end = interval[1]!; result.body = segment.text; result.segments = [segment];
        cursor.position = representation.tokens.length; state = 'done'; break;
      }
    }
  }
  return { ok: true, value: result };
}
