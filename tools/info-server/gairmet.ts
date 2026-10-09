import { SaxesParser } from 'saxes';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { FORECAST_HOURS, type SourceCollection } from '../../src/layers/weather-awc/source';
import { WeatherSourceError } from './source-error';

const decompress = promisify(gunzip);
type Element = { name: string; attributes: Record<string, string>; text: string; children: Element[] };
const invalid = (): never => { throw new WeatherSourceError('Invalid G-AIRMET cache document'); };
function one(node: Element, name: string): Element {
  const matches = node.children.filter(child => child.name === name);
  if (matches.length !== 1) return invalid();
  return matches[0]!;
}
function text(node: Element, name: string): string {
  const child = one(node, name);
  if (child.children.length) return invalid();
  return child.text.trim();
}
function integer(value: string | undefined, max: number): number {
  if (!value || !/^\d+$/.test(value)) return invalid();
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > max) return invalid();
  return number;
}
function instant(value: string): number {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value)) return invalid();
  const time = Date.parse(value);
  if (!Number.isFinite(time) || time <= 0) return invalid();
  return time;
}
function height(value: string | undefined): string | undefined {
  // These are the cache's explicit missing/surface encodings. Keep the original
  // XML member with every feature; numeric heights become the shared hundreds-ft form.
  if (value === undefined || ['', '-1', 'null00'].includes(value)) return undefined;
  if (value === 'SFC00') return 'SFC';
  if (value === 'FZL' || value === 'SFC') return value;
  const feet = integer(value, 100_000);
  if (feet % 100) return invalid();
  return String(feet / 100).padStart(3, '0');
}

/** One AWC-produced full dataset, never a merge of separately queried frames.
 * Bounds apply before XML parsing; DTDs/entities and incomplete envelopes fail closed. */
export async function readGairmetCache(compressed: Buffer): Promise<SourceCollection[]> {
  if (compressed.length > 4 * 1024 * 1024) return invalid();
  let xml: string;
  try { xml = new TextDecoder('utf-8', { fatal: true }).decode(await decompress(compressed, { maxOutputLength: 8 * 1024 * 1024 })); }
  catch { return invalid(); }
  const parser = new SaxesParser({ xmlns: true }), stack: Element[] = [];
  let root: Element | undefined, nodes = 0;
  parser.on('doctype', invalid);
  parser.on('error', invalid);
  parser.on('opentag', tag => {
    if (tag.uri || stack.length >= 12 || ++nodes > 300_000) return invalid();
    const node: Element = { name: tag.local, attributes: {}, text: '', children: [] };
    for (const attribute of Object.values(tag.attributes)) {
      if (!attribute.uri) node.attributes[attribute.local] = attribute.value;
    }
    if (stack.length) stack.at(-1)!.children.push(node);
    else { if (root) return invalid(); root = node; }
    stack.push(node);
  });
  const append = (value: string) => {
    if (!stack.length) { if (value.trim()) invalid(); return; }
    const node = stack.at(-1)!;
    node.text += value;
    if (node.text.length > 100_000) invalid();
  };
  parser.on('text', append); parser.on('cdata', append);
  parser.on('closetag', () => { stack.pop(); });
  parser.write(xml).close();
  if (!root || root.name !== 'response' || root.attributes.version !== '2.0' || stack.length) return invalid();
  const envelope = ['request_index', 'data_source', 'request', 'errors', 'warnings', 'time_taken_ms', 'data'];
  if (root.text.trim() || root.children.length !== envelope.length || root.children.some(node => !envelope.includes(node.name))) return invalid();
  for (const name of envelope) one(root, name);
  for (const name of ['errors', 'warnings']) {
    const node = one(root, name);
    if (node.text.trim() || node.children.length) return invalid();
  }
  if (one(root, 'data_source').attributes.name !== 'gairmet' || one(root, 'request').attributes.type !== 'retrieve') return invalid();
  const data = one(root, 'data');
  if (integer(data.attributes.num_results, 1995) !== data.children.length || data.text.trim()) return invalid();
  const collections: SourceCollection[] = FORECAST_HOURS.map(() => ({ type: 'FeatureCollection', features: [] }));
  const bases = new Set<number>();
  for (const member of data.children) {
    if (member.name !== 'GAIRMET' || member.text.trim()) return invalid();
    const hour = integer(text(member, 'roughly_the_number_of_hours_between_the_issue_time_and_the_valid_time'), 12);
    const index = FORECAST_HOURS.findIndex(value => value === hour);
    if (index < 0) return invalid();
    const validTime = text(member, 'valid_time'), issueTime = text(member, 'issue_time');
    const receiptTime = text(member, 'receipt_time'), expireTime = text(member, 'expire_time');
    const validAt = instant(validTime), issuedAt = instant(issueTime);
    instant(receiptTime);
    if (instant(expireTime) <= issuedAt) return invalid();
    bases.add(validAt - hour * 3_600_000);
    if (bases.size !== 1) return invalid();
    const hazard = one(member, 'hazard').attributes;
    const properties: Record<string, unknown> = { product: text(member, 'product'), tag: text(member, 'tag'),
      hazard: hazard.type, forecast: hour, validTime, issueTime, receiptTime, expireTime, sourceXml: member };
    if (hazard.severity) properties.severity = hazard.severity;
    const due = member.children.filter(child => child.name === 'due_to');
    if (due.length > 1) return invalid();
    if (due.length) properties.dueTo = text(member, 'due_to');
    for (const altitude of member.children.filter(child => child.name === 'altitude')) {
      for (const [key, field] of [['min_ft_msl', 'base'], ['max_ft_msl', 'top'], ['level_ft_msl', 'level']] as const) {
        const value = height(altitude.attributes[key]);
        if (value !== undefined) { if (properties[field] !== undefined) return invalid(); properties[field] = value; }
      }
    }
    const freezing = one(member, 'fzl_altitude');
    for (const [key, field] of [['min_ft_msl', 'fzlbase'], ['max_ft_msl', 'fzltop']] as const) {
      const value = height(text(freezing, key));
      if (value !== undefined) properties[field] = value;
    }
    const areas = member.children.filter(child => child.name === 'area');
    let geometry: unknown = null;
    if (areas.length === 1) {
      const area = areas[0]!;
      if (integer(area.attributes.num_points, 10_000) !== area.children.length || area.text.trim()) return invalid();
      const coordinates = area.children.map(point => {
        if (point.name !== 'point') return invalid();
        const values = [text(point, 'longitude'), text(point, 'latitude')];
        if (values.some(value => !/^-?\d+(?:\.\d+)?$/.test(value))) return invalid();
        return values.map(Number);
      });
      const kind = text(member, 'geometry_type');
      // FZLVL is an isoline even when closed and labeled AREA in the XML. AWC's
      // GeoJSON emits those same points as LineString; M_FZLVL remains an area.
      if (kind === 'LINE' || kind === 'AREA' && hazard.type === 'FZLVL') geometry = { type: 'LineString', coordinates };
      else if (kind === 'AREA') geometry = { type: 'Polygon', coordinates: [coordinates] };
    }
    const collection = collections[index]!;
    collection.features.push({ type: 'Feature', properties, geometry });
    if (collection.features.length >= 400) return invalid();
  }
  return collections;
}
