import { SaxesParser } from 'saxes';
import { isAircraftReport, isUnlocatedAircraftReport, type AircraftReport, type UnlocatedAircraftReport,
  type PirepPayload, type PirepSnapshot } from '@zlayer/contracts';
import { jsonIdentity } from '../../../core/data/json-identity';
import { readPirepTime } from './text';

type Element = { name: string; attributes: Record<string, string>; text: string; children: Element[] };
function invalid(): never { throw new Error('Report fields unavailable or invalid'); }
class SourceQualityError extends Error {
  constructor(readonly qualityFlag: 'bad_location' | 'no_time_stamp', message: string) { super(message); }
}
class SourceLocationError extends Error {
  constructor(readonly report: UnlocatedAircraftReport, readonly flagged: boolean,
    readonly sourceCoordinate?: [number, number]) {
    super(flagged ? 'AWC flagged the report location as unreliable' : 'Report location unavailable');
  }
}
function child(node: Element, name: string) {
  const nodes = node.children.filter(c => c.name === name);
  if (nodes.length > 1) invalid();
  return nodes[0];
}
function value(node: Element, name: string) {
  const n = child(node, name);
  if (n?.children.length) invalid();
  return n?.text.trim();
}
function instant(v: string | undefined): number {
  if (!v || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(v)) return invalid();
  const t = Date.parse(v);
  // Reject calendar overflow before accepting an offset-equivalent instant.
  const [year, month, day] = v.slice(0, 10).split('-').map(Number);
  if (!Number.isFinite(t) || t <= 0 || month! < 1 || month! > 12 || day! < 1 || day! > new Date(Date.UTC(year!, month!, 0)).getUTCDate()) invalid();
  return t;
}
function number(v: string | undefined) {
  if (!v || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(v) || !Number.isFinite(Number(v))) return invalid();
  return Number(v);
}
function altitude(v: string): number {
  if (!/^[+-]?\d+$/.test(v) || !Number.isInteger(Number(v)) || Number(v) < -2000 || Number(v) > 100_000) invalid();
  return Number(v);
}
function normalize(node: Element, sourceXml: string, checkedAt: number): AircraftReport {
  const flags = child(node, 'quality_control_flags');
  if (flags?.text.trim() || flags && new Set(flags.children.map(n => n.name)).size !== flags.children.length) invalid();
  const quality = flags?.children
    .filter(n => {
      if (n.children.length) invalid();
      const value = n.text.trim().toUpperCase();
      if (!['TRUE', 'FALSE', '1', '0'].includes(value)) invalid();
      return value === 'TRUE' || value === '1';
    }).map(n => n.name).sort() ?? [];
  const raw = child(node, 'raw_text');
  if (raw?.children.length) invalid();
  const observation = value(node, 'observation_time');
  const decodeTime = quality.includes('no_time_stamp') || !observation;
  const observedAt = decodeTime ? readPirepTime(raw?.text ?? '', checkedAt) : instant(observation);
  if (observedAt === undefined) {
    if (quality.includes('no_time_stamp')) throw new SourceQualityError('no_time_stamp', 'Observation time unavailable; no usable /TM');
    invalid();
  }
  if (observedAt > checkedAt + 60_000) invalid();
  const receipt = value(node, 'receipt_time');
  const reportedAltitude = value(node, 'altitude_ft_msl');
  const uncertainAltitude = quality.some(q => ['no_flt_lvl', 'flt_lvl_range', 'above_ground_level_indicated'].includes(q));
  const conditions = (name: string, prefix: string, fields: string[]) => node.children.filter(c => c.name === name).map(c => {
    if (c.children.length || c.text.trim()) invalid();
    const a = c.attributes, baseKey = `${prefix}_base_ft_msl`, topKey = `${prefix}_top_ft_msl`;
    if (Object.keys(a).some(key => ![...fields, baseKey, topKey].includes(key))) invalid();
    // XML attribute order is insignificant. Keep summaries and identities stable.
    const description = fields.map(key => a[key]?.trim()).filter(Boolean).join(' ');
    const base = a[baseKey] === undefined ? undefined : altitude(a[baseKey].trim());
    const top = a[topKey] === undefined ? undefined : altitude(a[topKey].trim());
    if (base !== undefined && top !== undefined && base > top) invalid();
    return [description || 'Unspecified', base !== undefined || top !== undefined ? `${base ?? '?'}–${top ?? '?'} ft MSL` : ''].filter(Boolean).join(' · ');
  });
  // Preserve validated observations for /OV decoding. A location failure
  // must not conceal malformed time, conditions, duplicate fields or raw text.
  const lon = value(node, 'longitude'), lat = value(node, 'latitude');
  let sourceCoordinate: [number, number] | undefined;
  try {
    const longitude = number(lon), latitude = number(lat);
    if (Math.abs(longitude) <= 180 && Math.abs(latitude) <= 90) sourceCoordinate = [longitude, latitude];
  } catch { /* Missing/non-numeric coordinates can still have a standard /OV. */ }
  const flagged = quality.includes('bad_location');
  const location = !flagged && sourceCoordinate ? { longitude: sourceCoordinate[0], latitude: sourceCoordinate[1] } : undefined;
  const report = { observedAt, receivedAt: receipt ? instant(receipt) : null, ...location,
    altitudeFt: uncertainAltitude || reportedAltitude === undefined || reportedAltitude === '' ? null : altitude(reportedAltitude),
    type: value(node, 'report_type') || 'Unknown', urgent: value(node, 'report_type') === 'Urgent PIREP',
    aircraft: value(node, 'aircraft_ref') ?? '', turbulence: conditions('turbulence_condition', 'turbulence', ['turbulence_type', 'turbulence_intensity', 'turbulence_freq']),
    icing: conditions('icing_condition', 'icing', ['icing_type', 'icing_intensity']), sky: conditions('sky_condition', 'cloud', ['sky_cover']), quality,
    text: raw?.text ?? '', sourceXml, ...(decodeTime ? { timeSource: 'raw' as const } : {}) };
  // Receipt time can differ for a retransmission. Deduplicate only otherwise
  // identical interpreted reports and raw text; preserve independent observations.
  const { receivedAt: _receipt, sourceXml: _xml, ...identity } = report;
  const result = { id: jsonIdentity(identity), ...report };
  if (!location) {
    const { sourceXml: _source, ...unlocated } = result;
    if (!isUnlocatedAircraftReport(unlocated)) invalid();
    throw new SourceLocationError(unlocated, flagged, sourceCoordinate);
  }
  if (!isAircraftReport(result)) return invalid();
  return result;
}

/** Interpret a single bounded member; a bad entry cannot discard its neighbors. */
function readMember(xml: string): Element {
  if (!xml || xml.length > 20_000) invalid();
  const parser = new SaxesParser({ xmlns: true }), stack: Element[] = [];
  let root: Element | undefined, nodes = 0;
  parser.on('doctype', invalid); parser.on('error', invalid);
  parser.on('opentag', tag => {
    if (tag.uri || stack.length >= 12 || ++nodes > 2000) invalid();
    const node: Element = { name: tag.local, attributes: {}, text: '', children: [] };
    for (const a of Object.values(tag.attributes)) if (!a.uri) node.attributes[a.local] = a.value;
    if (stack.length) stack.at(-1)!.children.push(node);
    else { if (root) invalid(); root = node; }
    stack.push(node);
  });
  const append = (text: string) => {
    if (stack.length) stack.at(-1)!.text += text;
    else if (text.trim()) invalid();
  };
  parser.on('text', append); parser.on('cdata', append);
  parser.on('closetag', () => { stack.pop(); });
  parser.write(xml).close();
  if (!root || root.name !== 'AircraftReport' || root.text.trim() || stack.length) return invalid();
  return root;
}

/** Source bytes stay in the cache. Interpretation and deduplication belong to the PWA.
 * Legacy issues must be decoded from XML too: deployed schema-1 servers may omit
 * issue.report entirely, even when the raw report contains a usable /OV. */
export function decodePirepSource(source: PirepPayload): PirepSnapshot {
  const reports = new Map<string, AircraftReport>(source.schemaVersion === 1 ? source.reports.map(r => [r.id, r]) : []);
  const issues: PirepSnapshot['issues'] = [];
  const records = source.schemaVersion === 2 ? source.records : source.issues.map(issue => issue.sourceXml);
  for (const [index, original] of records.entries()) {
    try {
      const report = normalize(readMember(original), original, source.checkedAt);
      const prior = reports.get(report.id);
      if (!prior || (report.receivedAt ?? Infinity) < (prior.receivedAt ?? Infinity)) reports.set(report.id, report);
    } catch (cause) {
      issues.push({ id: source.schemaVersion === 1 ? source.issues[index]!.id : `issue-${index}-${jsonIdentity({ sourceXml: original })}`,
        reason: cause instanceof Error ? cause.message : 'Report fields unavailable or invalid',
        ...(cause instanceof SourceQualityError ? { qualityFlag: cause.qualityFlag } : {}),
        ...(cause instanceof SourceLocationError ? { report: cause.report, ...(cause.flagged ? { qualityFlag: 'bad_location' as const,
          ...(cause.sourceCoordinate ? { sourceCoordinate: cause.sourceCoordinate } : {}) } : {}) } : {}),
        sourceXml: original.length > 20_000 ? original.slice(0, 19_950) + '\n[Source excerpt]' : original });
    }
  }
  return { schemaVersion: 1, checkedAt: source.checkedAt, source: source.source,
    reports: [...reports.values()].sort((a, b) => b.observedAt - a.observedAt || a.id.localeCompare(b.id)), issues };
}
