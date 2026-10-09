import { gzipSync } from 'node:zlib';
import type { SourceCollection, SourceFeature } from '../../src/layers/weather-awc/source';

const escape = (value: unknown) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const element = (name: string, value: unknown) => `<${name}>${escape(value)}</${name}>`;
const feet = (value: unknown) => value === undefined ? '-1' : /^\d+$/.test(String(value)) ? String(Number(value) * 100) : String(value);
/** Synthetic source serialization for the real gzip/XML transport in server/browser tests. */
export function gairmetXml(collections: readonly SourceCollection[]): string {
  const records = collections.flatMap(collection => collection.features) as SourceFeature[];
  return '<response version="2.0"><request_index>1</request_index><data_source name="gairmet"/>' +
    '<request type="retrieve"/><errors/><warnings/><time_taken_ms>0</time_taken_ms>' +
    `<data num_results="${records.length}">` + records.map(feature => {
      const p = feature.properties, g = feature.geometry;
      const points = g.type === 'Polygon' ? g.coordinates[0]! : g.type === 'LineString' ? g.coordinates : [];
      return '<GAIRMET>' + element('receipt_time', p.receiptTime ?? p.issueTime) + element('issue_time', p.issueTime) +
        element('expire_time', new Date(Date.parse(String(p.issueTime)) + 6 * 3_600_000).toISOString()) +
        element('product', p.product) + element('tag', p.tag) +
        element('roughly_the_number_of_hours_between_the_issue_time_and_the_valid_time', p.forecast) +
        element('valid_time', p.validTime) + `<hazard type="${escape(p.hazard)}" severity="${escape(p.severity)}"/>` +
        element('geometry_type', g.type === 'LineString' ? 'LINE' : g.type === 'Polygon' ? 'AREA' : 'UNKNOWN') +
        element('due_to', p.dueTo) + `<altitude min_ft_msl="${escape(feet(p.base))}" max_ft_msl="${escape(feet(p.top))}"/>` +
        '<fzl_altitude>' + element('min_ft_msl', feet(p.fzlbase)) + element('max_ft_msl', feet(p.fzltop)) + '</fzl_altitude>' +
        `<altitude level_ft_msl="${escape(feet(p.level))}"/><area num_points="${points.length}">` +
        points.map(point => '<point>' + element('longitude', point[0]) + element('latitude', point[1]) + '</point>').join('') +
        '</area></GAIRMET>';
    }).join('') + '</data></response>';
}
export function gairmetResponse(collections: readonly SourceCollection[], now = Date.now()): Response {
  return new Response(Uint8Array.from(gzipSync(gairmetXml(collections))),
    { headers: { 'content-type': 'application/octet-stream', 'last-modified': new Date(now).toUTCString() } });
}
