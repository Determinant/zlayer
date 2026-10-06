import type { NotamRecord } from '@zlayer/contracts';
import type { FeatureCollection, Point, Polygon } from 'geojson';
import { notamObstacleFeatures, notamObstacles, mappedObstacleRemainder } from './obstacles';
import { notamArea } from './areas';
import { notamValidity } from './validity';
import { parseNotam } from './parser';
import { NOTAM_COORDINATE, notamCoordinate } from './coordinates';
import { presentNotam } from './presentation';

type Properties = { kind: 'obstacle' | 'area' | 'area-label'; noticeId: string; label: string; timing: string;
  icon?: string; shape?: string; elevationMslFt?: number };
export type NotamChartCollection = FeatureCollection<Point | Polygon, Properties>;
export { notamChartKey } from './public';

export function notamChartFeatures(records: readonly NotamRecord[], now: number): NotamChartCollection {
  const features: NotamChartCollection['features'] = notamObstacleFeatures(records, now).features
    .map(feature => ({ ...feature, properties: { ...feature.properties, kind: 'obstacle' } }));
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.id) || ['cancelled', 'cancellation'].includes(record.lifecycle)) continue;
    seen.add(record.id);
    const area = notamArea(record), timing = notamValidity(record, now);
    if (!area || timing === 'past end') continue;
    const label = area.label + (timing === 'within interval' ? '' : `\n${timing.replace(/^./, char => char.toUpperCase())}`);
    features.push({ type: 'Feature', id: `${record.id}:area`, geometry: { type: 'Polygon', coordinates: [area.ring] },
      properties: { kind: 'area', noticeId: record.id, label, timing } },
    { type: 'Feature', id: `${record.id}:label`, geometry: { type: 'Point', coordinates: area.labelPosition },
      properties: { kind: 'area-label', noticeId: record.id, label, timing } });
  }
  return { type: 'FeatureCollection', features };
}

const presentations = new WeakMap<NotamRecord, { presentation: ReturnType<typeof presentNotam>; note: string } | null>();
/** Used only after the renderer acknowledges the current record. Source/raw and search remain complete. */
export function chartedNotamPresentation(record: NotamRecord) {
  if (presentations.has(record)) return presentations.get(record) ?? undefined;
  const body = parseNotam(record).body, area = notamArea(record), obstacles = notamObstacles(record);
  const spans = area ? [area.span] : [...body.matchAll(NOTAM_COORDINATE)].flatMap(match => {
    const point = notamCoordinate(match);
    return point && obstacles.some(obstacle => obstacle.coordinates.every((v, i) => v === point[i]))
      ? [{ start: match.index, end: match.index + match[0].length }] : [];
  });
  if (!spans.length) { presentations.set(record, null); return undefined; }
  let abbreviated = body;
  for (const span of [...spans].reverse()) abbreviated = abbreviated.slice(0, span.start) + abbreviated.slice(span.end);
  const remainder = !area ? mappedObstacleRemainder(record) : undefined;
  const text = (remainder ?? abbreviated).replace(/[ \t]{2,}/g, ' ').trim();
  const presentation = text ? presentNotam({ ...record, text }) : { blocks: [], sourceSpans: [], searchText: '' };
  const result = { presentation,
    note: area ? area.outer ? 'Outer area shown on chart · Extent varies with altitude' : 'Area shown on chart' : 'Location shown on chart' };
  presentations.set(record, result); return result;
}
