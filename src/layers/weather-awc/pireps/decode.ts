import { SaxesParser } from 'saxes';
import { isAircraftReport, isUnlocatedAircraftReport, isPirepSourceSnapshot, type AircraftReport, type UnlocatedAircraftReport,
  type PirepPayload, type PirepSnapshot } from '@zlayer/contracts';
import { jsonIdentity } from '../../../core/data/json-identity';
import { readPirepFields, readPirepTime } from './text';
import { pirepContent } from './content';

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
const qualifiedAltitude = (quality: string[]) => quality.some(q => ['no_flt_lvl', 'flt_lvl_range', 'above_ground_level_indicated'].includes(q));
function readContent(node: Element, raw: string, quality: string[]) {
  const reportedAltitude = value(node, 'altitude_ft_msl');
  const uncertainAltitude = qualifiedAltitude(quality);
  const altitudeFt = uncertainAltitude || reportedAltitude === undefined || reportedAltitude === '' ? null : altitude(reportedAltitude);
  const sourceNotes: string[] = [];
  const conditions = (name: string, prefix: string, fields: string[]) => node.children.filter(c => c.name === name).map(c => {
    if (c.children.length || c.text.trim()) invalid();
    const a = c.attributes, baseKey = `${prefix}_base_ft_msl`, topKey = `${prefix}_top_ft_msl`;
    if (Object.keys(a).some(key => ![...fields, baseKey, topKey].includes(key))) invalid();
    // XML attribute order is insignificant. Keep summaries and identities stable.
    const description = fields.map(key => a[key]?.trim()).filter(Boolean).join(' ');
    const base = a[baseKey] === undefined ? undefined : altitude(a[baseKey].trim());
    const top = a[topKey] === undefined ? undefined : altitude(a[topKey].trim());
    const heights = base !== undefined && top !== undefined && base > top
      ? `reported base ${base} / top ${top} ft MSL (inconsistent)`
      : base !== undefined || top !== undefined ? `${base ?? '?'}–${top ?? '?'} ft MSL` : '';
    if (name === 'icing_condition' && a.icing_intensity === 'NEGclr') {
      sourceNotes.push(`AWC icing qualifier: NEGclr${heights ? ` · ${heights}` : ''} (not an explicit negative icing report)`);
      return undefined;
    }
    return [description || 'Unspecified', heights].filter(Boolean).join(' · ');
  }).filter((condition): condition is string => condition !== undefined);
  const content = pirepContent(raw, { altitudeFt, aircraft: value(node, 'aircraft_ref') ?? '',
    turbulence: conditions('turbulence_condition', 'turbulence', ['turbulence_type', 'turbulence_intensity', 'turbulence_freq']),
    icing: conditions('icing_condition', 'icing', ['icing_type', 'icing_intensity']), sky: conditions('sky_condition', 'cloud', ['sky_cover']) }, uncertainAltitude);
  return sourceNotes.length ? { ...content, contentNotes: [...content.contentNotes ?? [], ...sourceNotes] } : content;
}
function reportIdentity(report: Omit<AircraftReport, 'id' | 'longitude' | 'latitude'> & Partial<Pick<AircraftReport, 'longitude' | 'latitude'>>) {
  // Keep a fixed field order across raw and legacy interpretation paths.
  return jsonIdentity({ ...(report.timeSource === 'receipt' ? {} : { observedAt: report.observedAt }),
    longitude: report.longitude, latitude: report.latitude, altitudeFt: report.altitudeFt,
    type: report.type, urgent: report.urgent, aircraft: report.aircraft,
    turbulence: report.turbulence, icing: report.icing, sky: report.sky, quality: report.quality, text: report.text,
    ...(report.timeSource ? { timeSource: report.timeSource } : {}), ...(report.contentNotes ? { contentNotes: report.contentNotes } : {}) });
}
function refreshLegacyContent(report: AircraftReport): AircraftReport {
  if (!readPirepFields(report.text)) return report;
  const { altitudeFt, aircraft, turbulence, icing, sky } = report;
  let content = pirepContent(report.text, { altitudeFt, aircraft, turbulence, icing, sky }, qualifiedAltitude(report.quality));
  // A previous client may already have replaced a conflicting number with null.
  // Reconcile against the original XML number so restoring that view cannot turn
  // a known conflict into a newly trusted raw altitude.
  try {
    const node = readMember(report.sourceXml);
    if (value(node, 'raw_text') === report.text.trim()) content = readContent(node, report.text, report.quality);
  } catch { /* Legacy excerpts may not contain usable XML; keep their validated fields as the comparison basis. */ }
  if (JSON.stringify([content.altitudeFt, content.aircraft, content.turbulence, content.icing, content.sky, content.contentNotes]) ===
      JSON.stringify([altitudeFt, aircraft, turbulence, icing, sky, report.contentNotes])) return report;
  const { contentNotes: _notes, ...original } = report;
  const result = { ...original, ...content };
  return { ...result, id: reportIdentity(result) };
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
  const receipt = value(node, 'receipt_time');
  const receivedAt = receipt ? instant(receipt) : null;
  let observedAt = decodeTime ? readPirepTime(raw?.text ?? '', checkedAt) : instant(observation);
  let timeSource: AircraftReport['timeSource'] = decodeTime ? 'raw' : undefined;
  // Keep a report with unknown observation time inspectable. Receipt is an
  // explicitly labeled age/expiry basis, never a corrected observation time.
  // Retain expired receipts too: deduplication must see the earliest receipt
  // before the display's age filter runs. Otherwise a later duplicate revives it.
  if (observedAt === undefined && receivedAt !== null && receivedAt <= checkedAt) {
    observedAt = receivedAt; timeSource = 'receipt';
  }
  if (observedAt === undefined) {
    if (quality.includes('no_time_stamp')) throw new SourceQualityError('no_time_stamp', 'Observation time unavailable; no usable /TM');
    invalid();
  }
  if (observedAt > checkedAt + 60_000) invalid();
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
  // Validate the structured source even when raw fields can recover a better
  // interpretation. Raw clauses own their qualifiers and height associations.
  const content = readContent(node, raw?.text ?? '', quality);
  const report = { observedAt, receivedAt, ...location,
    ...content,
    type: value(node, 'report_type') || 'Unknown', urgent: value(node, 'report_type') === 'Urgent PIREP',
    quality,
    text: raw?.text ?? '', sourceXml, ...(timeSource ? { timeSource } : {}) };
  // Receipt time can differ for a retransmission. Deduplicate only otherwise
  // identical interpreted reports and raw text; preserve independent observations.
  const result = { id: reportIdentity(report), ...report };
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
export function decodePirepSource(source: PirepPayload, receiptEvidence: readonly string[] = []): PirepSnapshot {
  if (!isPirepSourceSnapshot({ schemaVersion: 2, checkedAt: source.checkedAt, source: source.source, records: receiptEvidence }))
    throw new Error('Invalid or oversized PIREP receipt evidence');
  const reports = new Map<string, AircraftReport>();
  if (source.schemaVersion === 1) for (const original of source.reports) {
    const report = refreshLegacyContent(original), prior = reports.get(report.id);
    if (!prior || (report.receivedAt ?? Infinity) < (prior.receivedAt ?? Infinity)) reports.set(report.id, report);
  }
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
  // Earlier XML witnesses may constrain only a receipt-based identity present
  // in this publication. They cannot restore absent reports, alter known times,
  // or bypass validation. Reinterpret against the current source clock.
  const unlocated = new Map<string, number[]>();
  issues.forEach((issue, index) => {
    if (issue.report?.timeSource !== 'receipt') return;
    const indices = unlocated.get(issue.report.id) ?? []; indices.push(index); unlocated.set(issue.report.id, indices);
  });
  for (const xml of receiptEvidence) {
    try {
      const earlier = normalize(readMember(xml), xml, source.checkedAt), current = reports.get(earlier.id);
      if (earlier.timeSource === 'receipt' && current?.timeSource === 'receipt' && earlier.receivedAt! < current.receivedAt!)
        reports.set(earlier.id, earlier);
    } catch (cause) {
      if (!(cause instanceof SourceLocationError) || cause.report.timeSource !== 'receipt') continue;
      for (const index of unlocated.get(cause.report.id) ?? []) {
        const current = issues[index]!;
        if (cause.report.receivedAt! >= current.report!.receivedAt!) continue;
        issues[index] = { id: current.id, reason: cause.message, sourceXml: xml, report: cause.report,
          ...(cause.flagged ? { qualityFlag: 'bad_location', ...(cause.sourceCoordinate ? { sourceCoordinate: cause.sourceCoordinate } : {}) } : {}) };
      }
    }
  }
  return { schemaVersion: 1, checkedAt: source.checkedAt, source: source.source,
    reports: [...reports.values()].sort((a, b) => b.observedAt - a.observedAt || a.id.localeCompare(b.id)), issues };
}

/** Keep only the current publication's earliest receipt witnesses, including
 * expired/unlocated members. Original XML supplies the retained time and ID;
 * no navigation-derived position or synthesized timestamp is persisted. */
export function pirepReceiptEvidence(snapshot: PirepSnapshot): string[] {
  const earliest = new Map<string, { receivedAt: number; xml: string }>();
  const remember = (report: AircraftReport | UnlocatedAircraftReport | undefined, xml: string) => {
    if (report?.timeSource !== 'receipt') return;
    const prior = earliest.get(report.id);
    if (!prior || report.receivedAt! < prior.receivedAt) earliest.set(report.id, { receivedAt: report.receivedAt!, xml });
  };
  snapshot.reports.forEach(report => remember(report, report.sourceXml));
  snapshot.issues.forEach(issue => remember(issue.report, issue.sourceXml));
  const records = [...earliest.values()].map(value => value.xml);
  if (!isPirepSourceSnapshot({ schemaVersion: 2, checkedAt: snapshot.checkedAt, source: snapshot.source, records }))
    throw new Error('PIREP receipt evidence exceeds retention limits');
  return records;
}
