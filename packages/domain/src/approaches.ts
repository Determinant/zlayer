import type { ApproachFix, ApproachLeg, ApproachRoute, ApproachRoutesData, GeoPointFeature } from '@zlayer/contracts';
import type { ApproachArrival, RouteLeg, RoutePlan, RouteWaypoint } from './route-model.js';
import type { RouteOwner } from './route-source.js';
import { distanceNm, geographicMidpoint } from './route.js';
import { arrivalBearing, bearing, destination, holdingEntry } from './approach-geometry.js';
import { findApproachRoutes } from './approach-matching.js';
export { approachIdent, findApproachRoute, findApproachRoutes } from './approach-matching.js';
import { joinApproachTransition } from './approach-joining.js';

export type ApproachEntryOption = { id: string; name: string; kind: 'fix' | 'vectors' };
export type { ApproachPreview } from './approach-path.js';
import { resolveApproachLegs, type ApproachPreview } from './approach-path.js';

/** A coded fix can remain pinned after its airport bundle is decomposed. The
 * coordinate distinguishes local runway names and identically named fixes. */
export function approachFixFeature(fix: ApproachFix): GeoPointFeature {
  return { type: 'Feature', id: `approach-fix:${JSON.stringify([fix.ident, ...fix.coordinate])}`,
    geometry: { type: 'Point', coordinates: fix.coordinate }, properties: { ident: fix.ident, name: fix.ident } };
}

export function approachEntryOptions(procedure: ApproachRoute): ApproachEntryOption[] {
  return entrySelections(procedure).map(({ legs: _legs, ...option }) => option);
}

function entrySelections(procedure: ApproachRoute): (ApproachEntryOption & { legs: ApproachLeg[] })[] {
  const entries: (ApproachEntryOption & { legs: ApproachLeg[] })[] = [];
  const signatures = new Set<string>();
  const add = (id: string, legs: ApproachLeg[], deduplicate = true) => {
    const first = legs[0];
    if (!first?.fix) return;
    // The incoming leg ends at the chosen fix. Preserve holds and outbound legs.
    if (['IF', 'TF', 'CF', 'DF', 'RF', 'AF'].includes(first.path)) legs = [{ path: 'IF', fix: first.fix, ...(first.id ? { id: first.id } : {}) }, ...legs.slice(1)];
    const signature = JSON.stringify(legs.map(({ id: _source, ...leg }) => leg));
    if (deduplicate && signatures.has(signature)) return;
    signatures.add(signature);
    entries.push({ id, name: first.fix.ident, kind: 'fix', legs });
  };
  const joined = (legs: ApproachLeg[]) => joinApproachTransition(procedure, legs);
  for (const transition of procedure.transitions) {
    const first = transition.legs[0];
    if (first?.path === 'IF' || first?.path === 'FC' || first?.fix?.role === 'IAF') add(`transition:${transition.id}`, joined(transition.legs), false);
  }
  const addInitialFixes = (legs: ApproachLeg[], id: (index: number) => string, join: (legs: ApproachLeg[]) => ApproachLeg[], hasStart = false) => {
    for (const [index, leg] of legs.entries()) {
      if (leg.missed || leg.fix?.role === 'FAF') break;
      if (leg.fix?.role !== 'IAF') continue;
      if (hasStart && legs.slice(0, index).every(prior => prior.fix && sameFix(prior.fix, leg.fix!))) continue;
      add(id(index), join(legs.slice(index)));
    }
  };
  for (const transition of procedure.transitions) {
    const first = transition.legs[0];
    addInitialFixes(transition.legs, index => `transition-fix:${transition.id}:${index}`, joined,
      first?.path === 'IF' || first?.path === 'FC' || first?.fix?.role === 'IAF');
  }
  addInitialFixes(procedure.final, index => `final:${index}`, legs => legs);
  const names = entries.map(entry => entry.name);
  for (const entry of entries) {
    if (names.filter(name => name === entry.name).length < 2) continue;
    const next = entry.legs.find(leg => leg.fix && leg.fix.ident !== entry.name && !leg.missed)?.fix;
    if (next) entry.name += ` via ${next.ident}`;
  }
  const paths = entries.map(entry => entry.name);
  for (const entry of entries) if (paths.filter(name => name === entry.name).length > 1 &&
    entry.legs.some(leg => !leg.missed && ['HF', 'HA', 'HM'].includes(leg.path))) entry.name += ' (hold)';
  const labels = entries.map(entry => entry.name);
  for (const entry of entries) if (labels.filter(name => name === entry.name).length > 1) {
    // Keep distinct coded paths distinguishable even when their fix names agree.
    entry.name += ` (${entry.id.startsWith('transition-fix:') ? 'from' : 'branch'} ${entry.id.split(':')[1]})`;
  }
  const vector = finalCourse(procedure);
  if (vector) entries.push({ id: 'vectors', name: 'VTF', kind: 'vectors', legs: procedure.final.slice(vector.index) });
  // A radar-entry procedure can begin at an IF and have a curved final that
  // cannot accept VTF. Expose its coded start without inventing a straight final.
  const start = procedure.final[0];
  if (!entries.length && start?.path === 'IF' && start.fix?.role === 'IF' && !start.missed) {
    add('final:0', procedure.final);
    entries[0]!.name += ' (IF)';
  }
  return entries;
}

export function approachEntryLegs(procedure: ApproachRoute, entryId: string): ApproachLeg[] | undefined {
  return entrySelections(procedure).find(entry => entry.id === entryId)?.legs;
}

export function approachPreview(procedure: ApproachRoute, entryId: string): ApproachPreview | undefined {
  const legs = approachEntryLegs(procedure, entryId);
  if (!legs) return undefined;
  const vector = entryId === 'vectors' ? finalCourse(procedure) : undefined;
  const result = resolveApproachLegs(procedure, legs);
  if (vector) result.extension = [destination(vector.fix.coordinate, vector.course + 180, 30), vector.fix.coordinate];
  return result;
}

function finalCourse(procedure: ApproachRoute) {
  const index = procedure.final.findIndex(leg => leg.fix?.role === 'FAF' && !leg.missed);
  const fix = procedure.final[index]?.fix, next = procedure.final[index + 1];
  if (!fix || !next?.fix || next.missed || !['CF', 'TF'].includes(next.path)) return undefined;
  return { index, fix, course: bearing(fix.coordinate, next.fix.coordinate) };
}

/** Replace the airport's route connections, keeping its editable marker and the complete bundle. */
export function expandRouteApproaches(plan: RoutePlan, data?: ApproachRoutesData,
  resolveFix?: (fix: ApproachFix) => Pick<RouteWaypoint, 'layer' | 'feature'> | undefined): void {
  const replacements = new Map<RouteWaypoint, { first?: RouteWaypoint; last?: RouteWaypoint; children: RouteWaypoint[] }>();
  const legs: RouteLeg[] = [];
  for (const airport of plan.waypoints) {
    const selected = plan.entries[airport.source.tokenIndex]?.approach;
    if (!selected || airport.layer !== 'airports' || !airport.edit) continue;
    const selection = selected.entry;
    const procedure = selection && data?.metadata.effectiveDate === selection.effectiveDate
      ? [airport.ident, airport.feature.properties.icaoId, airport.feature.properties.faaId]
        .filter((id): id is string => typeof id === 'string')
        .flatMap(id => findApproachRoutes(data, id, selected.name)).find(p => p.id === selection.routeId) : undefined;
    const preview = procedure && approachPreview(procedure, selection!.transitionId);
    if (!preview) {
      // Older chart-only attachments still need an explicit entry; do not silently pick one.
      replacements.set(airport, { children: [] });
      plan.issues.push({ ...airport.source, code: 'approach-unavailable', message: selection
        ? `${airport.ident}: selected approach entry is unavailable in this data edition`
        : `${airport.ident}: choose a published approach entry or VTF` });
      continue;
    }
    const owner: RouteOwner = { kind: 'approach', source: airport.source, ident: selected.name };
    const children = preview.points.map((fix, index): RouteWaypoint => ({ source: airport.source, owners: [owner],
      ident: fix.ident, approachRole: fix.role ?? '', approachPhase: fix.missed ? 'missed' : 'approach',
      ...(index === preview.landingEnd ? { approachLandingEnd: true } : {}),
      ...(fix.hold ? { approachHold: { turn: fix.hold, missedEnd: Boolean(fix.missed && index === preview.exit),
        ...(fix.holdCourse !== undefined ? { inboundCourse: fix.holdCourse } : {}),
        ...(fix.arrivalCourse !== undefined ? { arrivalCourse: fix.arrivalCourse } : {}),
        ...(fix.holdLength ? { length: fix.holdLength } : {}) } } : {}),
      ...(resolveFix?.(fix) ?? { layer: 'fixes', feature: approachFixFeature(fix) }) }));
    for (const segment of preview.segments) {
      const from = children[segment.from]!, to = children[segment.to]!;
      legs.push({ from, to, owners: [owner], approachPhase: segment.phase, geometry: segment.coordinates,
        midpoint: geographicMidpoint(from.feature.geometry.coordinates, to.feature.geometry.coordinates),
        distanceNm: segment.coordinates.slice(1).reduce((sum, coordinate, index) => sum + distanceNm(segment.coordinates[index]!, coordinate), 0) });
    }
    replacements.set(airport, { ...(!preview.extension && children[0] ? { first: children[0] } : {}),
      ...(preview.exit !== undefined ? { last: children[preview.exit]! } : {}), children });
    if (preview.extension) (plan.approachExtensions ??= []).push(preview.extension);
    if (preview.depictions.length) (plan.approachDepictions ??= []).push(...preview.depictions);
    if (preview.incomplete) plan.issues.push({ ...airport.source, code: 'approach-discontinuity',
      message: `${airport.ident}: ${[...new Set(preview.issues.map(i => i.message))].join(' ')} See the plate.` });
  }
  // Keep preview arrival context independently of the selected approach. VTF and
  // coincident entry fixes intentionally remove their connecting map leg.
  for (const leg of plan.legs) {
    if (leg.to.layer !== 'airports' || !leg.to.edit) continue;
    const from = replacements.has(leg.from) ? replacements.get(leg.from)!.last : leg.from;
    if (!from) continue;
    const incoming = legs.find(candidate => candidate.to === from) ?? plan.legs.find(candidate => candidate.to === from);
    const course = from.approachHold?.arrivalCourse ?? (incoming && legArrivalCourse(incoming));
    leg.to.approachArrival = { coordinate: from.feature.geometry.coordinates, ...(course === undefined ? {} : { course }) };
  }
  if (!replacements.size) return;
  const connections = plan.legs.flatMap((leg): RouteLeg[] => {
    const from = replacements.has(leg.from) ? replacements.get(leg.from)!.last : leg.from;
    const to = replacements.has(leg.to) ? replacements.get(leg.to)!.first : leg.to;
    if (!from || !to || sameFix({ ident: from.ident, coordinate: from.feature.geometry.coordinates }, { ident: to.ident, coordinate: to.feature.geometry.coordinates })) return [];
    if (from === leg.from && to === leg.to) return [leg];
    // The connector still inserts between the same draft entries, even when
    // its displayed endpoints are children of an attached approach.
    return [{ from, to, owners: [...leg.owners, ...from.owners, ...to.owners],
      ...(leg.edit ? { edit: leg.edit } : {}),
      midpoint: geographicMidpoint(from.feature.geometry.coordinates, to.feature.geometry.coordinates),
      distanceNm: distanceNm(from.feature.geometry.coordinates, to.feature.geometry.coordinates) }];
  });
  plan.waypoints = plan.waypoints.flatMap(point => [...(replacements.get(point)?.children ?? []), point]);
  const order = new Map(plan.waypoints.map((point, index) => [point, index]));
  plan.legs = [...connections, ...legs].sort((a, b) => order.get(a.from)! - order.get(b.from)!);
  updateApproachHoldEntries(plan);
}

/** Entry suggestions follow the planned arrival. A preview can supply its connected arrival context. */
export function updateApproachHoldEntries(plan: RoutePlan, context?: ApproachArrival): void {
  for (const point of plan.waypoints) {
    const hold = point.approachHold;
    if (!hold) continue;
    let arrival = hold.arrivalCourse;
    // An explicitly filed entry fix may coincide with the bundle's first child;
    // its zero-length connector is deliberately omitted from the route.
    const prior = plan.waypoints[plan.waypoints.indexOf(point) - 1];
    const coincident = prior && sameFix({ ident: prior.ident, coordinate: prior.feature.geometry.coordinates },
      { ident: point.ident, coordinate: point.feature.geometry.coordinates }) ? prior : undefined;
    const incoming = plan.legs.find(leg => leg.to === point || leg.to === coincident);
    if (arrival === undefined && incoming) {
      arrival = legArrivalCourse(incoming);
    }
    if (arrival === undefined && point === plan.waypoints[0] && context) {
      arrival = arrivalBearing(context.coordinate, point.feature.geometry.coordinates) ?? context.course;
    }
    if (hold.inboundCourse !== undefined && arrival !== undefined && hold.turn !== 'unknown') {
      hold.entry = holdingEntry(hold.inboundCourse, arrival, hold.turn);
    } else delete hold.entry;
    point.approachRole = `${hold.missedEnd ? 'MAHF · ' : ''}HOLD${hold.turn === 'unknown' ? '' : ` ${hold.turn}`} · ${hold.entry?.toUpperCase() ?? 'ENTRY ?'}${hold.length ? `\n${hold.length}` : ''}`;
  }
}

function legArrivalCourse(leg: RouteLeg): number | undefined {
  const coordinates = leg.geometry ?? [leg.from.feature.geometry.coordinates, leg.to.feature.geometry.coordinates];
  return coordinates.length < 2 ? undefined : arrivalBearing(coordinates.at(-2)!, coordinates.at(-1)!);
}

function sameFix(a: ApproachFix, b: ApproachFix): boolean {
  return a.ident === b.ident && distanceNm(a.coordinate, b.coordinate) < 0.01;
}
