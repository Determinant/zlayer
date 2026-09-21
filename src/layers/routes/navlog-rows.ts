import { distanceNm, type RouteLeg, type RoutePlan, type RouteWaypoint } from '@zlayer/domain';
import { magneticBearing, magneticField, type MagneticModel } from '../../core/geo/magnetic-model';

export type NavLogRow = {
  waypoint: RouteWaypoint;
  section: string;
  gap: string;
  course: string;
  distanceNm: number | null;
  totalNm: number;
};

/** Use connected legs, keyed by occurrence: identifiers can repeat within one route. */
export function navLogRows(plan: RoutePlan, model: MagneticModel | null, time = Date.now()) {
  const incoming = new Map<RouteWaypoint, RouteLeg[]>();
  const approachSources = new Set<string>();
  for (const leg of plan.legs) {
    const legs = incoming.get(leg.to) ?? [];
    legs.push(leg);
    incoming.set(leg.to, legs);
  }
  for (const point of plan.waypoints) if (point.approachPhase) approachSources.add(point.source.entryId);
  // Attached airports remain editable map markers, not extra flown endpoints after the missed approach.
  const points = plan.waypoints.filter(point => !(point.layer === 'airports' && point.edit &&
    approachSources.has(point.source.entryId)));
  let totalNm = 0, previousSection = '';
  const rows: NavLogRow[] = points.map((waypoint, index) => {
    const legs = incoming.get(waypoint) ?? [];
    const previous = points[index - 1];
    const approach = plan.entries[waypoint.source.tokenIndex]?.approach;
    const firstApproachPoint = waypoint.approachPhase === 'approach' &&
      (!previous?.approachPhase || previous.source.entryId !== waypoint.source.entryId);
    const vectors = firstApproachPoint && approach?.entry?.transitionId === 'vectors';
    const coincident = previous?.ident === waypoint.ident &&
      distanceNm(previous.feature.geometry.coordinates, waypoint.feature.geometry.coordinates) < .01;
    const gap = vectors ? 'Vectors to final · distance unknown'
      : previous && !legs.length && !coincident ? 'Unmeasured segment' : '';
    const sectionLabel = waypoint.owners.map(owner => owner.kind === 'approach'
      ? `${owner.source.token} · ${owner.ident}` : owner.ident).join(' · ');
    const sectionKey = `${waypoint.source.entryId}:${sectionLabel}:${waypoint.approachPhase ?? ''}`;
    const section = sectionLabel && sectionKey !== previousSection
      ? `${waypoint.approachPhase === 'missed' ? 'Missed approach · ' : ''}${sectionLabel}` : '';
    previousSection = sectionKey;
    const distance = legs.length ? legs.reduce((sum, leg) => sum + leg.distanceNm, 0) : null;
    totalNm += distance ?? 0;
    return { waypoint, section, gap, course: legs.length === 1 ? legCourse(legs[0]!, model, time)
      : legs.length > 1 ? 'Varies' : '—', distanceNm: distance, totalNm };
  });
  return { rows, incomplete: plan.issues.length > 0 || plan.procedures.length > 0 ||
    !!plan.approachDepictions?.length || rows.some(row => row.gap !== '') };
}

function legCourse(leg: RouteLeg, model: MagneticModel | null, time: number): string {
  // A curved/composite path has no single course. Its distance still comes from the full geometry.
  if (leg.geometry && leg.geometry.length > 2) return 'Varies';
  const [start, end] = leg.geometry ?? [leg.from.feature.geometry.coordinates, leg.to.feature.geometry.coordinates];
  if (!start || !end) return '—';
  const rad = Math.PI / 180, delta = (end[0] - start[0]) * rad;
  const a = start[1] * rad, b = end[1] * rad;
  const x = Math.sin(delta) * Math.cos(b);
  const y = Math.cos(a) * Math.sin(b) - Math.sin(a) * Math.cos(b) * Math.cos(delta);
  if (Math.hypot(x, y) < 1e-10 || Math.abs(start[1]) === 90) return '—';
  const field = model ? magneticField(model, start, 0, time) : null;
  const magnetic = field !== null && field.horizontal >= 6000;
  const bearing = Math.atan2(x, y) / rad;
  const magneticCourse = magnetic ? formatCourse(magneticBearing(bearing, field.declination), 'M') : '—';
  return `${magneticCourse} / ${formatCourse(bearing, 'T')}`;
}

function formatCourse(course: number, reference: 'M' | 'T'): string {
  return `${String((Math.round(course) + 360) % 360).padStart(3, '0')}°${reference}`;
}
