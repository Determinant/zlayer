import type { ApproachLeg, ApproachRoute, ApproachRoutesData } from '@zlayer/contracts';
import type { ApproachArrival, RouteLeg, RoutePlan } from './route-model.js';
import { arrivalBearing, bearing, destination, holdingEntry } from './approach-geometry.js';
export { approachIdent, findApproachRoute, findApproachRoutes, publishedApproachRoutes } from './approach-matching.js';
import { joinApproachTransition } from './approach-joining.js';

export type ApproachEntryOption = { id: string; name: string; kind: 'fix' | 'vectors' };
export type { ApproachPreview } from './approach-path.js';
import { resolveApproachLegs, type ApproachPreview } from './approach-path.js';
import { sameTerminalFix as sameFix } from './terminal-fixes.js';
import { approachIndex } from './terminal-index.js';
export { terminalFixFeature as approachFixFeature } from './terminal-fixes.js';

/** A database procedure stays selectable even without a matching chart title. */
export function codedApproachLabel(ident: string): string {
  const families: Record<string, string> = { I: 'ILS', L: 'LOC', B: 'LOC BC', R: 'RNAV (GPS)', H: 'RNAV (RNP)',
    V: 'VOR', S: 'VOR', D: 'VOR/DME', N: 'NDB', Q: 'NDB/DME', X: 'LDA', U: 'SDF', P: 'GPS' };
  const match = /^([A-Z])(\d{2}[LCR]?)(?:-?([A-Z]))?$/.exec(ident);
  return match && families[match[1]!] ? `${families[match[1]!]}${match[3] ? ` ${match[3]}` : ''} RWY ${match[2]} · ${ident}` : ident;
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
    if (['IF', 'TF', 'CF', 'DF', 'RF', 'AF'].includes(first.path)) legs = [{ path: 'IF', fix: first.fix, ...(first.id ? { id: first.id } : {}),
      ...(first.altitude ? { altitude: first.altitude } : {}), ...(first.speed ? { speed: first.speed } : {}),
      ...(first.rnpNm !== undefined ? { rnpNm: first.rnpNm } : {}),
      ...(first.continuations ? { continuations: first.continuations } : {}) }, ...legs.slice(1)];
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

/** Resolve a saved choice without modifying the route. Chart and direct CIFP
 * identities stay distinct; a stale or absent entry never selects a default. */
export function selectedApproach(selected: import('./route-model.js').RouteApproach,
  data: ApproachRoutesData | undefined, aliases: readonly (string | undefined)[]) {
  const selection = selected.entry;
  const procedure = selection && data?.metadata.effectiveDate === selection.effectiveDate
    ? approachIndex(data).byId.get(selection.routeId) : undefined;
  if (!procedure || !aliases.includes(selected.airportId) || !aliases.includes(procedure.airport)) return;
  const preview = approachPreview(procedure, selection!.transitionId);
  return preview ? { preview, legs: approachEntryLegs(procedure, selection!.transitionId) ?? [] } : undefined;
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

export function legArrivalCourse(leg: RouteLeg): number | undefined {
  const coordinates = leg.geometry ?? [leg.from.feature.geometry.coordinates, leg.to.feature.geometry.coordinates];
  return coordinates.length < 2 ? undefined : arrivalBearing(coordinates.at(-2)!, coordinates.at(-1)!);
}
