import type { ApproachFix, ApproachLeg, TerminalProceduresData } from '@zlayer/contracts';
import type { ApproachPreview } from './approach-path.js';
import { selectedApproach, legArrivalCourse, updateApproachHoldEntries } from './approaches.js';
import { selectedCodedTerminal } from './coded-terminals.js';
import { terminalConstraint } from './procedure-constraints.js';
import { terminalFixFeature, sameTerminalFix, TERMINAL_FIX_TOLERANCE_NM } from './terminal-fixes.js';
import { distanceNm, geographicMidpoint } from './route.js';
import type { RouteLeg, RoutePlan, RouteWaypoint } from './route-model.js';
import type { RouteOwner } from './route-source.js';

type Kind = 'departure' | 'arrival' | 'approach';
type Attachment = { kind: Kind; owner: RouteOwner; preview?: ApproachPreview; children: RouteWaypoint[] };
type AirportAttachments = Partial<Record<Kind, Attachment>>;
const fixOf = (point: RouteWaypoint): ApproachFix => ({ ident: point.ident, coordinate: point.feature.geometry.coordinates });
const samePoint = (a: RouteWaypoint, b: RouteWaypoint) => sameTerminalFix(fixOf(a), fixOf(b));

/** One composition boundary owns terminal children, enroute connectors and
 * STAR/approach gaps. Source adapters return geometry and never modify a plan. */
export function composeTerminals(plan: RoutePlan, data?: TerminalProceduresData,
  resolveFix?: (fix: ApproachFix) => Pick<RouteWaypoint, 'layer' | 'feature'> | undefined): void {
  const airports = new Map<RouteWaypoint, AirportAttachments>();
  const baseLegs = plan.legs, procedureLegs: RouteLeg[] = [];
  const covered = new Map<RouteWaypoint, Set<RouteWaypoint>>();
  const openEnds = new Map<RouteWaypoint, ApproachFix['coordinate']>();
  const cover = (from: RouteWaypoint, to: RouteWaypoint) => {
    if (!covered.has(from)) covered.set(from, new Set());
    covered.get(from)!.add(to);
  };
  const report = (airport: RouteWaypoint, code: 'procedure-branch' | 'approach-unavailable' | 'approach-discontinuity', message: string) =>
    plan.issues.push({ ...airport.source, code, message });
  const attach = (airport: RouteWaypoint, kind: Kind, ident: string, preview?: ApproachPreview, legs: readonly ApproachLeg[] = []): Attachment => {
    const owner: RouteOwner = { kind: kind === 'approach' ? 'approach' : 'procedure', source: airport.source, ident };
    const children = (preview?.points ?? []).map((fix, index): RouteWaypoint => ({
      source: airport.source, owners: [owner], ident: fix.ident,
      ...(kind === 'approach' ? {
        approachRole: fix.role ?? '', approachPhase: fix.missed ? 'missed' as const : 'approach' as const,
        ...(index === preview!.landingEnd ? { approachLandingEnd: true as const } : {}),
        ...(fix.hold ? { approachHold: { turn: fix.hold, missedEnd: Boolean(fix.missed && index === preview!.exit),
          ...(fix.holdCourse !== undefined ? { inboundCourse: fix.holdCourse } : {}),
          ...(fix.arrivalCourse !== undefined ? { arrivalCourse: fix.arrivalCourse } : {}),
          ...(fix.holdLength ? { length: fix.holdLength } : {}) } } : {}),
      } : {}),
      procedureConstraint: [...new Set(legs.filter(l => l.fix && sameTerminalFix(l.fix, fix) &&
        (kind !== 'approach' || Boolean(l.missed) === Boolean(fix.missed))).map(terminalConstraint).filter(Boolean))].join(' / '),
      ...(resolveFix?.(fix) ?? { layer: 'fixes', feature: terminalFixFeature(fix) }),
    }));
    const attachment: Attachment = { kind, owner, children, ...(preview ? { preview } : {}) };
    if (kind === 'arrival' && preview?.exit !== undefined) children[preview.exit]!.arrivalEnd = true;
    // Reuse explicit airway/filing endpoints, keeping their scoped ownership.
    const boundary = enrouteBoundary(attachment);
    if (kind !== 'approach' && boundary) {
      const adjoining = baseLegs.map(l => kind === 'departure' && l.from === airport ? l.to :
        kind === 'arrival' && l.to === airport ? l.from : undefined).find(p => p && samePoint(p, boundary));
      if (adjoining) {
        adjoining.owners = [...adjoining.owners, owner];
        if (boundary.procedureConstraint) adjoining.procedureConstraint = boundary.procedureConstraint;
        if (boundary.arrivalEnd) adjoining.arrivalEnd = true;
        children[children.indexOf(boundary)] = adjoining;
      }
    }
    if (preview) {
      // A schematic curve already connects these fixes; never add a chord over it.
      for (const span of preview.spans) if (span.kind !== 'gap' && span.coordinates.length > 1 && span.from !== undefined && span.to !== undefined) {
        cover(children[span.from]!, children[span.to]!);
      }
      for (const span of preview.spans) if (span.kind !== 'gap' && span.coordinates.length > 1 && span.from !== undefined && span.to === undefined) {
        openEnds.set(children[span.from]!, span.coordinates.at(-1)!);
      }
      for (const segment of preview.segments) {
        if (segment.from === segment.to && kind !== 'approach') continue;
        const from = children[segment.from]!, to = children[segment.to]!;
        procedureLegs.push({ from, to, owners: [owner], geometry: segment.coordinates,
          ...(kind === 'approach' ? { approachPhase: segment.phase } : {}),
          midpoint: geographicMidpoint(from.feature.geometry.coordinates, to.feature.geometry.coordinates),
          distanceNm: segment.coordinates.slice(1).reduce((sum, p, i) => sum + distanceNm(segment.coordinates[i]!, p), 0) });
      }
      if (preview.extension) (plan.approachExtensions ??= []).push(preview.extension);
      if (preview.depictions.length) (plan.approachDepictions ??= []).push(...preview.depictions);
      (plan.terminalPaths ??= []).push({ kind, owner, spans: preview.spans, issues: preview.issues, policy: preview.policy });
    }
    return attachment;
  };
  for (const airport of plan.waypoints) {
    if (airport.layer !== 'airports' || !airport.edit) continue;
    const entry = plan.entries[airport.source.tokenIndex]!;
    const aliases = [airport.ident, airport.feature.properties.icaoId, airport.feature.properties.faaId];
    const attachments: AirportAttachments = {};
    for (const kind of ['arrival', 'departure'] as const) {
      const selection = entry[kind];
      if (selection?.source !== 'cifp') continue;
      const selected = selectedCodedTerminal(selection, kind, data, aliases);
      attachments[kind] = attach(airport, kind, selection.ident, selected?.preview, selected?.path.legs);
      if (!selected) { report(airport, 'procedure-branch', `${selection.ident}: selected procedure branches are unavailable in this data edition`); continue; }
      plan.procedures.push({ tokenIndex: airport.source.tokenIndex, ident: selected.procedure.ident, kind,
        airport: selected.procedure.airport, transition: selection.transition, points: [], partial: selected.preview.incomplete });
      if (selected.preview.issues.length) report(airport, 'procedure-branch',
        `${selection.ident}: ${[...new Set(selected.preview.issues.map(i => i.message))].join(' ')}`);
    }
    if (entry.approach) {
      const selected = selectedApproach(entry.approach, data?.approaches, aliases);
      attachments.approach = attach(airport, 'approach', entry.approach.name, selected?.preview, selected?.legs);
      if (!selected) report(airport, 'approach-unavailable', entry.approach.entry
        ? `${airport.ident}: selected approach entry is unavailable in this data edition`
        : `${airport.ident}: choose a published approach entry or VTF`);
      else if (selected.preview.incomplete) report(airport, 'approach-discontinuity',
        `${airport.ident}: ${[...new Set(selected.preview.issues.map(i => i.message))].join(' ')} See the plate.`);
    }
    if (Object.keys(attachments).length) airports.set(airport, attachments);
  }
  const endpoint = (point: RouteWaypoint, direction: 'from' | 'to') => {
    const attachments = airports.get(point);
    if (!attachments) return point;
    const selected = direction === 'from' ? attachments.departure ?? attachments.approach : attachments.arrival ?? attachments.approach;
    if (!selected) return point;
    if (selected.kind !== 'approach') return enrouteBoundary(selected);
    return direction === 'from' ? exit(selected) : selected.preview?.extension ? undefined : selected.children[0];
  };
  // Arrival context remains available to VTF/holding previews even when there
  // is deliberately no connecting route leg.
  const arrivalContext = (airport: RouteWaypoint, from: RouteWaypoint) => {
    const incoming = procedureLegs.find(l => l.to === from) ?? baseLegs.find(l => l.to === from);
    const course = from.approachHold?.arrivalCourse ?? (incoming && legArrivalCourse(incoming));
    airport.approachArrival = { coordinate: from.feature.geometry.coordinates, ...(course === undefined ? {} : { course }) };
  };
  for (const leg of baseLegs) if (leg.to.layer === 'airports' && leg.to.edit) {
    const from = endpoint(leg.from, 'from');
    if (from) arrivalContext(leg.to, from);
  }
  for (const [airport, attachments] of airports) {
    const arrival = attachments.arrival && exit(attachments.arrival), approach = attachments.approach;
    if (!arrival || !approach) continue;
    arrivalContext(airport, arrival);
    if (approach.children[0] && !approach.preview?.extension && !samePoint(arrival, approach.children[0])) {
      report(airport, 'approach-discontinuity', `${airport.ident}: the STAR ends at ${arrival.ident}; the selected approach starts at ${approach.children[0].ident}. No connecting clearance is assumed.`);
    }
  }
  const connections = baseLegs.flatMap((leg): RouteLeg[] => {
    const from = endpoint(leg.from, 'from'), to = endpoint(leg.to, 'to');
    if (!from || !to) return [];
    if (from === leg.from && to === leg.to) return [leg];
    if (samePoint(from, to)) return [];
    const coded = airports.get(leg.from)?.departure ?? airports.get(leg.to)?.arrival;
    if (coded && from.ident === to.ident) {
      const airport = airports.has(leg.from) ? leg.from : leg.to;
      report(airport, 'procedure-branch', `${coded.owner.ident}: the adjoining fix does not match the published transition coordinates`);
      return [];
    }
    if (coded && distanceNm(from.feature.geometry.coordinates, to.feature.geometry.coordinates) < TERMINAL_FIX_TOLERANCE_NM) return [];
    return [{ from, to, owners: [...leg.owners, ...from.owners, ...to.owners], ...(leg.edit ? { edit: leg.edit } : {}),
      midpoint: geographicMidpoint(from.feature.geometry.coordinates, to.feature.geometry.coordinates),
      distanceNm: distanceNm(from.feature.geometry.coordinates, to.feature.geometry.coordinates) }];
  });
  const original = new Set(plan.waypoints);
  plan.waypoints = plan.waypoints.flatMap(point => {
    const selected = airports.get(point);
    const added = (attachment: Attachment | undefined) => attachment?.children.filter(p => !original.has(p)) ?? [];
    return [...added(selected?.arrival), ...added(selected?.approach), point, ...added(selected?.departure)];
  });
  plan.legs = [...connections, ...procedureLegs];
  for (const leg of plan.legs) cover(leg.from, leg.to);
  // Procedure points replace bundle markers in the flown sequence. Preserve an
  // airport reached by an incoming leg before a departure (an intermediate stop).
  const reached = new Set(plan.legs.map(leg => leg.to));
  const sequence = plan.waypoints.filter(point => {
    const selected = airports.get(point);
    return !selected?.approach?.children.length && (!selected?.departure?.children.length || reached.has(point));
  });
  plan.planningConnections = sequence.slice(1).flatMap((to, index) => {
    const from = sequence[index]!;
    return covered.get(from)?.has(to) || distanceNm(openEnds.get(from) ?? from.feature.geometry.coordinates, to.feature.geometry.coordinates) < 1e-7
      ? [] : [{ from, to, ...(openEnds.has(from) ? { start: openEnds.get(from)! } : {}) }];
  });
  updateApproachHoldEntries(plan);
}

const exit = (attachment: Attachment) => attachment.preview?.exit === undefined ? undefined : attachment.children[attachment.preview.exit];
function enrouteBoundary(attachment: Attachment): RouteWaypoint | undefined {
  return attachment.kind === 'departure' ? exit(attachment) : attachment.preview?.spans[0]?.kind === 'gap' ? undefined : attachment.children[0];
}
