import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { SaxesParser } from 'saxes';
import { isPirepSourceSnapshot, PIREP_MAX_RECORDS, PIREP_MAX_XML_BYTES, type PirepSourceSnapshot } from '@zlayer/contracts';
import { WeatherSourceError } from './source-error';

export const PIREP_SOURCE = 'https://aviationweather.gov/data/cache/aircraftreports.cache.xml.gz';
type Element = { name: string; attributes: Record<string, string>; text: string; children: Element[] };
const invalid = (): never => { throw new WeatherSourceError('Incomplete or invalid aircraft-report cache'); };
function child(node: Element, name: string) {
  const nodes = node.children.filter(c => c.name === name);
  if (nodes.length > 1) invalid();
  return nodes[0];
}

/** Validate the complete transport envelope; preserve every member verbatim.
 * Report fields, quality flags, deduplication and location recovery belong to the PWA. */
export async function readPirepCache(compressed: Buffer, checkedAt: number): Promise<PirepSourceSnapshot> {
  if (compressed.length > 4 * 1024 * 1024) invalid();
  const xml = new TextDecoder('utf-8', { fatal: true }).decode(await promisify(gunzip)(compressed, { maxOutputLength: PIREP_MAX_XML_BYTES }));
  const parser = new SaxesParser({ xmlns: true }), stack: Element[] = [], records: string[] = [];
  let root: Element | undefined, nodes = 0, depth = 0, memberStart: number | undefined, memberDepth = 0;
  parser.on('doctype', invalid); parser.on('error', invalid);
  parser.on('opentag', tag => {
    if (++depth > 64 || ++nodes > 300_000) invalid();
    if (memberStart !== undefined) return;
    if (stack.length === 2 && stack[0]!.name === 'response' && stack[1]!.name === 'data' && tag.local === 'AircraftReport') {
      if (records.length >= PIREP_MAX_RECORDS) invalid();
      memberStart = xml.lastIndexOf('<', parser.position - 1); memberDepth = depth;
      return;
    }
    if (tag.uri) invalid();
    const node: Element = { name: tag.local, attributes: {}, text: '', children: [] };
    for (const a of Object.values(tag.attributes)) if (!a.uri) node.attributes[a.local] = a.value;
    if (stack.length) stack.at(-1)!.children.push(node);
    else { if (root) invalid(); root = node; }
    stack.push(node);
  });
  const append = (text: string) => {
    if (memberStart !== undefined) return;
    if (!stack.length) { if (text.trim()) invalid(); return; }
    const node = stack.at(-1)!;
    node.text += text;
    if (node.text.length > 20_000) invalid();
  };
  parser.on('text', append); parser.on('cdata', append);
  parser.on('closetag', () => {
    if (memberStart !== undefined) {
      if (depth === memberDepth) {
        records.push(xml.slice(memberStart, parser.position)); memberStart = undefined;
      }
    } else stack.pop();
    depth--;
  });
  parser.write(xml).close();
  if (!root || root.name !== 'response' || root.attributes.version !== '2.0' || stack.length || depth || root.text.trim()) invalid();
  for (const name of ['errors', 'warnings']) {
    const n = child(root!, name);
    if (!n || n.children.length || n.text.trim()) invalid();
  }
  if (child(root!, 'data_source')?.attributes.name !== 'aircraftreport' || child(root!, 'request')?.attributes.type !== 'retrieve') invalid();
  const data = child(root!, 'data'), count = data?.attributes.num_results;
  if (!data || !count || !/^\d+$/.test(count) || Number(count) !== records.length || data.children.length || data.text.trim()) invalid();
  const snapshot: PirepSourceSnapshot = { schemaVersion: 2, checkedAt, source: PIREP_SOURCE, records };
  if (!isPirepSourceSnapshot(snapshot)) invalid();
  return snapshot;
}
