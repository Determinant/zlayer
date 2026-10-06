import type { NotamRecord } from '@zlayer/contracts';
import type { FeatureCollection, Point, Polygon, MultiPolygon } from 'geojson';
import { notamObstacleFeatures, notamObstacles, mappedObstacleRemainder } from './obstacles';
import { notamArea } from './areas';
import { notamActivityPoint } from './activity-points';
import type { NotamAreaReferences } from './area-references';
import { notamValidity } from './validity';
import { parseNotam } from './parser';
import { presentNotam } from './presentation';
import { notamRadials, notamRadialDirections } from './radials';

type Properties = { kind: 'obstacle' | 'area' | 'area-label' | 'activity' | 'radial' | 'radial-label'; noticeId: string; label: string; timing: string;
  noticeIds: string[];
  icon?: string; shape?: string; elevationMslFt?: number; bearing?: number };
export type NotamChartCollection = FeatureCollection<Point | Polygon | MultiPolygon, Properties>;
export { notamChartKey } from './public';

export function notamChartFeatures(records: readonly NotamRecord[], now: number, references?: NotamAreaReferences): NotamChartCollection {
  const features: NotamChartCollection['features'] = notamObstacleFeatures(records, now, references).features
    .map(feature => ({ ...feature, properties: { ...feature.properties, noticeIds: [feature.properties.noticeId], kind: 'obstacle' } }));
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.id) || ['cancelled', 'cancellation'].includes(record.lifecycle)) continue;
    seen.add(record.id);
    const area = notamArea(record, references), timing = notamValidity(record, now);
    if (timing === 'past end') continue;
    const radialLabels = new Map<string, NotamChartCollection['features'][number]>();
    for (const radial of notamRadialDirections(record, references)) {
      const label = `${radial.ident} R-${String(radial.radial || 360).padStart(3, '0')}`;
      features.push({ type: 'Feature', id: `${record.id}:radial:${radial.ident}:${radial.radial}`,
        geometry: { type: 'Point', coordinates: radial.coordinates }, properties: { kind: 'radial',
          noticeId: record.id, noticeIds: [record.id], label, timing, bearing: radial.bearing } });
      const existing = radialLabels.get(radial.ident);
      if (existing) existing.properties.label += ` / R-${String(radial.radial || 360).padStart(3, '0')}`;
      else radialLabels.set(radial.ident, { type: 'Feature', id: `${record.id}:radial-label:${radial.ident}`,
        geometry: { type: 'Point', coordinates: radial.coordinates }, properties: { kind: 'radial-label',
          noticeId: record.id, noticeIds: [record.id], label, timing } });
    }
    for (const label of radialLabels.values()) {
      label.properties.label += `\nDirection only${timing === 'within interval' ? '' : ` · ${timing}`}`;
      features.push(label);
    }
    if (!area) {
      const point = notamActivityPoint(record);
      if (point) features.push({ type: 'Feature', id: `${record.id}:activity`, geometry: { type: 'Point', coordinates: point.coordinates },
        properties: { kind: 'activity', noticeId: record.id, noticeIds: [record.id],
          label: point.label + (timing === 'within interval' ? '' : `\n${timing.replace(/^./, char => char.toUpperCase())}`), timing } });
      continue;
    }
    const label = area.label + (timing === 'within interval' ? '' : `\n${timing.replace(/^./, char => char.toUpperCase())}`);
    features.push({ type: 'Feature', id: `${record.id}:area`, geometry: area.polygons.length === 1 ? { type: 'Polygon', coordinates: area.polygons[0]! } : { type: 'MultiPolygon', coordinates: area.polygons },
      properties: { kind: 'area', noticeId: record.id, noticeIds: [record.id], label, timing } },
    { type: 'Feature', id: `${record.id}:label`, geometry: { type: 'Point', coordinates: area.labelPosition },
      properties: { kind: 'area-label', noticeId: record.id, noticeIds: [record.id], label, timing } });
  }
  // FAA can file the same footprint under different classifications or centers.
  // Share depiction only; every source identity keeps its receipt and highlight.
  const shared = new Map<string, NotamChartCollection['features'][number]>();
  for (const feature of features) {
    const { noticeId, noticeIds, ...display } = feature.properties;
    const key = JSON.stringify([feature.geometry, display]);
    const previous = shared.get(key);
    if (previous) previous.properties.noticeIds.push(...noticeIds.filter(id => !previous.properties.noticeIds.includes(id)));
    else shared.set(key, feature);
  }
  return { type: 'FeatureCollection', features: [...shared.values()] };
}

const presentations = new WeakMap<NotamRecord, { presentation: ReturnType<typeof presentNotam>; note: string } | null>();
/** Used only after the renderer acknowledges the current record. Source/raw and search remain complete. */
export function chartedNotamPresentation(record: NotamRecord) {
  if (presentations.has(record)) return presentations.get(record) ?? undefined;
  const body = parseNotam(record).body, area = notamArea(record), obstacles = notamObstacles(record);
  if (notamRadials(record).length) {
    const result = { presentation: presentNotam(record), note: 'Hover or focus to show VOR radial directions · See NOTAM for affected distances and altitudes' };
    presentations.set(record, result); return result;
  }
  if (area?.preserveText) {
    const result = { presentation: presentNotam(record), note: area.recovered ? 'Area shown on chart · Coordinate normalized; check source' : area.outer ? 'Outer area shown on chart · Extent varies with altitude' : 'Area shown on chart · See source location qualifications' };
    presentations.set(record, result); return result;
  }
  if (notamActivityPoint(record) || obstacles.some(point => point.recovered || point.preserveText)) {
    const result = { presentation: presentNotam(record), note: notamActivityPoint(record) ? 'Source position shown on chart · See NOTAM for affected extent'
      : obstacles.some(point => point.recovered) ? 'Location shown on chart · Coordinate normalized; check source' : 'Location shown on chart · See source qualifications' };
    presentations.set(record, result); return result;
  }
  const spans = area ? [area.span] : obstacles.map(obstacle => obstacle.coordinateSpan);
  if (!spans.length && !obstacles.length) { presentations.set(record, null); return undefined; }
  let abbreviated = body;
  for (const span of [...spans].sort((a, b) => b.start - a.start)) abbreviated = abbreviated.slice(0, span.start) + abbreviated.slice(span.end);
  const remainder = !area ? mappedObstacleRemainder(record) : undefined;
  const text = (remainder ?? abbreviated).replace(/[ \t]{2,}/g, ' ').trim();
  const presentation = text ? presentNotam({ ...record, text }) : { blocks: [], sourceSpans: [], searchText: '' };
  const result = { presentation,
    note: area ? area.outer ? 'Outer area shown on chart · Extent varies with altitude' : 'Area shown on chart' : 'Location shown on chart' };
  presentations.set(record, result); return result;
}
