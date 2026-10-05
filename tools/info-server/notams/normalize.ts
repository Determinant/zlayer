import { createHash } from 'node:crypto';
import { SaxesParser, type SaxesTagNS } from 'saxes';
import { isNotamRecord, type NotamRecord } from '@zlayer/contracts';
import { NotamError } from './error';
import { notamEndKind, notamTime } from '../../../src/layers/notams/validity';

const AIXM = 'http://www.aixm.aero/schema/5.1';
const EVENT = `${AIXM}/event`, MESSAGE = `${AIXM}/message`, FNSE = `${AIXM}/extensions/FAA/FNSE`;
const GML = 'http://www.opengis.net/gml/3.2', WFS = 'http://www.opengis.net/wfs/2.0';
export const NOTAM_MAX_RECORDS = 150_000;
export const NOTAM_XML_MAX_BYTES = 512 * 1024 * 1024;
const MAX_MEMBER_BYTES = 2 * 1024 * 1024;
type Element = { uri: string; name: string; text: string; attributes: SaxesTagNS['attributes']; children: Element[]; parts: (string | Element)[] };
function descendants(node: Element, uri: string, name: string): Element[] {
  return node.children.flatMap(child => [
    ...(child.uri === uri && child.name === name ? [child] : []), ...descendants(child, uri, name),
  ]);
}
const childText = (node: Element, uri: string, name: string) => node.children.find(c => c.uri === uri && c.name === name)?.text.trim() ?? '';
const attribute = (node: Element, uri: string, name: string) => Object.values(node.attributes)
  .find(a => a.uri === uri && a.local === name)?.value;
const contentText = (node: Element): string => node.name === 'br' && node.uri === 'http://www.w3.org/1999/xhtml' ? '\n'
  : node.parts.map(part => typeof part === 'string' ? part : contentText(part)).join('');

function recordWithRevision(facts: Omit<NotamRecord, 'revision'>): NotamRecord {
  facts = { ...facts, endKind: notamEndKind(facts) };
  return { ...facts, revision: createHash('sha256').update(JSON.stringify(facts)).digest('hex') };
}

/** Upgrade saved derivations from retained source facts before accepting new deltas. */
export function upgradeNotamRecord(record: NotamRecord): NotamRecord {
  if (notamEndKind(record) === record.endKind) return record;
  const { revision: _revision, ...facts } = record;
  return recordWithRevision(facts);
}

function normalize(node: Element): NotamRecord {
  const sourceId = attribute(node, GML, 'id') ?? '';
  if (!/^(?:NMS_ID_)?\d{16}$/.test(sourceId)) throw new NotamError('invalid-source-id');
  const slices = descendants(node, EVENT, 'EventTimeSlice').filter(slice => descendants(slice, EVENT, 'NOTAM').length > 0);
  if (slices.length !== 1) throw new NotamError('unsupported-event-slices');
  const slice = slices[0]!;
  const notices = descendants(slice, EVENT, 'NOTAM'), extensions = descendants(slice, FNSE, 'EventExtension');
  if (notices.length !== 1 || extensions.length !== 1) throw new NotamError('invalid-event');
  const notice = notices[0]!, extension = extensions[0]!;
  const field = (name: string) => childText(notice, EVENT, name);
  const extra = (name: string) => childText(extension, FNSE, name);
  const sourceUpdatedAt = extra('lastUpdated'), updatedAt = notamTime(sourceUpdatedAt);
  if (updatedAt === null) throw new NotamError('missing-update-time');
  const effectiveStart = field('effectiveStart'), effectiveEnd = field('effectiveEnd');
  const changeType = field('type'), cancel = extra('canceled') || extra('cancelationDate') || extra('cancellationDate');
  const rawClass = extra('classification'), classification = rawClass === 'DOM' ? 'DOMESTIC' : rawClass || 'UNKNOWN';
  const codeList = (s: string) => [...new Set(s.split(/[\s,]+/).filter(Boolean).map(s => s.toUpperCase()))];
  const sequence = childText(slice, AIXM, 'sequenceNumber'), correction = childText(slice, AIXM, 'correctionNumber');
  if (!/^\d+$/.test(sequence) || !/^\d+$/.test(correction)) throw new NotamError('invalid-event-revision');
  const facts: Omit<NotamRecord, 'revision'> = {
    id: sourceId.replace(/^NMS_ID_/, ''), sourceId, classification,
    number: field('number'), series: field('series'), year: field('year'),
    locations: codeList(field('location')), icaoLocations: codeList(extra('icaoLocation')), accountability: extra('accountId'),
    issuedAt: notamTime(field('issued')), updatedAt, sourceUpdatedAt, canceledAt: cancel,
    referred: field('referredNumber') ? { series: field('referredSeries'), number: field('referredNumber'), year: field('referredYear') } : null,
    startsAt: notamTime(effectiveStart), endsAt: notamTime(effectiveEnd),
    effectiveStart, effectiveEnd, endKind: effectiveEnd === 'PERM' ? 'permanent'
      : /EST$/.test(effectiveEnd) || /^(true|1)$/i.test(extra('estimated')) ? 'estimated'
        : notamTime(effectiveEnd) !== null ? 'fixed' : 'unknown',
    schedule: field('schedule'), changeType,
    // Global deltas carry the original source ID with FNSE:canceled. A NOTAMC
    // is a separate cancellation message, not the ID of the cancelled notice.
    // Legacy records omit type; absence of canceled retains their source state.
    lifecycle: cancel ? notamTime(cancel) !== null ? 'cancelled' : 'unknown'
      : changeType === 'C' ? 'cancellation' : ['', 'N', 'R'].includes(changeType) ? 'active' : 'unknown',
    text: field('text'), translations: descendants(notice, EVENT, 'NOTAMTranslation').map(t => ({
      type: childText(t, EVENT, 'type'), text: childText(t, EVENT, 'simpleText') ||
        t.children.filter(c => c.uri === EVENT && c.name === 'formattedText').map(contentText).join('\n').trim(),
    })), sequence: Number(sequence), correction: Number(correction),
  };
  const record = recordWithRevision(facts);
  if (!isNotamRecord(record)) throw new NotamError('invalid-record');
  return record;
}

/** Namespace-aware streaming reader retaining at most one bounded AIXM member. */
export function createNotamXmlParser(onRecord: (record: NotamRecord) => void,
  fragment?: { count: number; snapshotAt: number }) {
  const parser = new SaxesParser({ xmlns: true });
  let bytes = 0, depth = 0, memberBytes = 0, nodes = 0, records = 0;
  let collectionSeen = !!fragment, expected: number | undefined = fragment?.count, snapshotAt: number | null = fragment?.snapshotAt ?? null;
  let collectionDepth = 0, progress = 0;
  const stack: Element[] = [];
  parser.on('doctype', () => { throw new NotamError('xml-doctype-forbidden'); });
  parser.on('error', () => { throw new NotamError('invalid-xml'); });
  parser.on('opentag', tag => {
    progress = parser.position;
    if (++depth > 80 || Object.keys(tag.attributes).length > 64) throw new NotamError('xml-limit');
    if (tag.local === 'Fault' && tag.uri.includes('soap')) throw new NotamError('source-fault');
    if (tag.uri === WFS && tag.local === 'FeatureCollection') {
      if (collectionSeen) throw new NotamError('multiple-collections');
      collectionSeen = true;
      const count = tag.attributes.numberReturned?.value;
      if (!count || !/^\d+$/.test(count) || Number(count) > NOTAM_MAX_RECORDS) throw new NotamError('invalid-record-count');
      expected = Number(count); snapshotAt = notamTime(tag.attributes.timeStamp?.value ?? '');
      if (tag.attributes.next?.value || tag.attributes.numberMatched?.value && tag.attributes.numberMatched.value !== count) throw new NotamError('incomplete-collection');
      collectionDepth = depth;
      if (snapshotAt === null) throw new NotamError('missing-snapshot-time');
    }
    if (tag.uri === MESSAGE && tag.local === 'AIXMBasicMessage') {
      if (!collectionSeen || !fragment && !collectionDepth || stack.length) throw new NotamError('invalid-member');
      memberBytes = 0; nodes = 0;
    } else if (!stack.length) return;
    if (++nodes > 30_000) throw new NotamError('member-limit');
    memberBytes += Object.values(tag.attributes).reduce((n, a) => n + a.value.length, tag.name.length);
    if (memberBytes > MAX_MEMBER_BYTES) throw new NotamError('member-limit');
    const node: Element = { uri: tag.uri, name: tag.local, attributes: tag.attributes, text: '', children: [], parts: [] };
    stack.at(-1)?.children.push(node); stack.at(-1)?.parts.push(node); stack.push(node);
  });
  const append = (text: string) => {
    progress = parser.position;
    if (!stack.length) return;
    memberBytes += text.length;
    if (memberBytes > MAX_MEMBER_BYTES) throw new NotamError('member-limit');
    stack.at(-1)!.text += text;
    const parts = stack.at(-1)!.parts, last = parts.length - 1;
    if (typeof parts[last] === 'string') parts[last] += text; else parts.push(text);
  };
  parser.on('text', append); parser.on('cdata', append);
  parser.on('comment', () => { progress = parser.position; });
  parser.on('processinginstruction', () => { progress = parser.position; });
  parser.on('closetag', () => {
    progress = parser.position;
    if (depth === collectionDepth) collectionDepth = 0;
    depth--;
    const node = stack.pop();
    if (!node || stack.length) return;
    if (++records > NOTAM_MAX_RECORDS) throw new NotamError('record-limit');
    onRecord(normalize(node));
  });
  return {
    write(chunk: string) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > NOTAM_XML_MAX_BYTES) throw new NotamError('expanded-size-limit');
      parser.write(chunk);
      if (parser.position - progress > MAX_MEMBER_BYTES) throw new NotamError('xml-token-limit');
    },
    finish() {
      parser.close();
      if (!collectionSeen || records !== expected || stack.length || depth || snapshotAt === null) throw new NotamError('incomplete-collection');
      return { snapshotAt, count: records };
    },
  };
}
