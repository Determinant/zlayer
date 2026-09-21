import type { ApproachCoordinate as Coordinate, ApproachFix, ApproachLeg, ApproachRoute } from '@zlayer/contracts';
import type { ApproachDepiction } from './route-model.js';
import { distanceNm } from './route.js';
import { approachCourse, arrivalBearing, bearing, courseFromFix, courseIntercept, destination, holdingPattern, radiusArc } from './approach-geometry.js';
import { approachSchematicPolicy, difference, joinCourse, rangeIntersection, rayIntersection, selfCrosses, turnToFix, turnToHeading } from './approach-path-geometry.js';

export type ApproachPathIssue = {
  code: 'missing-reference' | 'unsupported-leg' | 'inconsistent-constraints' | 'no-forward-intersection' | 'manual-termination' | 'geometry-review';
  leg: number;
  source?: string;
  path: string;
  message: string;
};
export type ApproachSpan = {
  kind: 'fixed' | 'schematic' | 'gap';
  phase: 'approach' | 'missed';
  from?: number;
  to?: number;
  coordinates: Coordinate[];
  legs: number[];
  sources: string[];
  assumptions: string[];
  symbol?: ApproachDepiction['kind'];
  arrow?: ApproachDepiction['arrow'];
};
export type ApproachPreview = {
  points: (ApproachFix & { hold?: 'L' | 'R' | 'unknown'; holdLength?: string; holdCourse?: number; arrivalCourse?: number; missed?: boolean })[];
  spans: ApproachSpan[];
  issues: ApproachPathIssue[];
  segments: { from: number; to: number; coordinates: Coordinate[]; phase: 'approach' | 'missed' }[];
  depictions: ApproachDepiction[];
  extension?: Coordinate[];
  exit?: number;
  landingEnd?: number;
  /** Compatibility summary, derived from issues rather than maintained by leg handlers. */
  incomplete: boolean;
  policy: { version: number; climbScale: number };
};
const same = (a: Coordinate, b: Coordinate) => distanceNm(a, b) < .01;
const holds = new Set(['HA', 'HF', 'HM']);
const endpoints = new Set(['TF', 'CF', 'DF', 'RF', 'AF']);

// Only unambiguous feet constraints participate in the climb/return exception.
// These are published conditions, not a calculated vertical flight profile.
const altitudeFloor = (leg: ApproachLeg) => leg.altitude && ['', '+'].includes(leg.altitude.restriction) &&
  /^\d{5}$/.test(leg.altitude.first) ? Number(leg.altitude.first) : undefined;

/** Interpret one selected branch. Synthetic endpoints never become named fixes or
 * independent route legs. The adapters below are the only place spans become map
 * depictions or distance/terrain geometry.
 */
export function resolveApproachLegs(procedure: ApproachRoute, legs: readonly ApproachLeg[]): ApproachPreview {
  let result = interpret(procedure, legs, 1);
  // A fixed display climb length can miss an otherwise valid subsequent intercept.
  // Retry a small, deterministic set of scales, never change published courses.
  if (result.issues.some(i => i.code === 'no-forward-intersection' && i.path === 'VI') && legs.some(l => ['CA', 'VA', 'FA'].includes(l.path))) {
    for (const scale of approachSchematicPolicy.climbScales) {
      const candidate = interpret(procedure, legs, scale);
      if (candidate.issues.length < result.issues.length) result = candidate;
      if (!result.issues.length) break;
    }
  }
  return result;
}

function interpret(procedure: ApproachRoute, legs: readonly ApproachLeg[], climbScale: number): ApproachPreview {
  const points: ApproachPreview['points'] = [], spans: ApproachSpan[] = [], issues: ApproachPathIssue[] = [];
  const climbReturns = new Map<ApproachSpan, [number, number]>();
  let position: Coordinate | undefined, anchor: number | undefined, course: number | undefined, courseLeg: ApproachLeg | undefined;
  let chain: ApproachSpan | undefined, phase: 'approach' | 'missed' = 'approach';
  let landingEnd: number | undefined, missedStarted = false;
  const issue = (index: number, code: ApproachPathIssue['code'], message: string) => {
    const leg = legs[index]!;
    issues.push({ code, leg: index, path: leg.path, ...(leg.id ? { source: leg.id } : {}), message });
  };
  const gap = (index: number, code: ApproachPathIssue['code'], message: string) => {
    issue(index, code, message);
    spans.push({ kind: 'gap', phase, ...(anchor === undefined ? {} : { from: anchor }), coordinates: [],
      legs: [...(chain?.legs ?? []), index], sources: [...(chain?.sources ?? []), ...(legs[index]?.id ? [legs[index]!.id!] : [])], assumptions: [] });
    chain = undefined; position = undefined; anchor = undefined; course = undefined; courseLeg = undefined;
  };
  const append = (index: number, coordinates: Coordinate[], assumptions: string[] = [], symbol?: ApproachDepiction['kind']) => {
    if (!coordinates.length) return;
    chain ??= { kind: 'fixed', phase, ...(anchor === undefined ? {} : { from: anchor }), coordinates: [coordinates[0]!], legs: [], sources: [], assumptions: [] };
    for (const p of coordinates.slice(1)) if (distanceNm(chain.coordinates.at(-1)!, p) > 1e-7) chain.coordinates.push(p);
    if (!chain.legs.includes(index)) chain.legs.push(index);
    if (legs[index]?.id && !chain.sources.includes(legs[index]!.id!)) chain.sources.push(legs[index]!.id!);
    chain.assumptions = [...new Set([...chain.assumptions, ...assumptions])];
    if (chain.assumptions.length) chain.kind = 'schematic';
    if (symbol) chain.symbol = symbol;
    position = coordinates.at(-1)!;
  };
  const atFix = (fix: ApproachFix, leg: ApproachLeg) => {
    const arrived = chain !== undefined && chain.coordinates.length > 1;
    const previous = points.at(-1);
    const reuse = previous && previous.ident === fix.ident && same(previous.coordinate, fix.coordinate) && (!chain || chain.coordinates.length < 2);
    const index = reuse ? points.length - 1 : points.length;
    if (!reuse) points.push({ ...fix, ...(leg.missed ? { missed: true } : {}) });
    else if (fix.role && !(previous.role === 'IAF' && fix.role === 'IF')) previous.role = fix.role;
    if (chain) {
      // Surveyed termination wins over small spherical/encoding rounding errors.
      if (chain.coordinates.length > 1) {
        chain.coordinates[chain.coordinates.length - 1] = fix.coordinate;
        chain.to = index;
        if (chain.kind === 'schematic' && !chain.symbol) chain.symbol = phase === 'missed' ? 'missed' : 'intercept';
        spans.push(chain);
      }
      chain = undefined;
    }
    position = fix.coordinate; anchor = index;
    if (arrived && course !== undefined) points[index]!.arrivalCourse = course;
    return index;
  };
  const resolvedCourse = (leg: ApproachLeg) => {
    // A course-to-altitude continuing the same coded track retains that track's
    // datum. Heading legs deliberately use their own no-wind magnetic reference.
    if (!leg.path.startsWith('V') && !leg.reference && leg.trueCourse === undefined && leg.magneticCourse !== undefined &&
        courseLeg?.magneticCourse !== undefined && course !== undefined &&
        (leg.path === 'CA' || holds.has(leg.path)) && Math.abs(difference(leg.magneticCourse, courseLeg.magneticCourse)) < .2) return course;
    if (holds.has(leg.path) && leg.magneticCourse !== undefined && courseLeg?.magneticCourse !== undefined && course !== undefined &&
        Math.abs(Math.abs(difference(leg.magneticCourse, courseLeg.magneticCourse)) - 180) < .2) return (course + 180) % 360;
    return approachCourse(leg, procedure);
  };
  const nextEndpoint = (index: number) => {
    for (const leg of legs.slice(index + 1)) {
      if (Boolean(leg.missed) !== (phase === 'missed') || ['FM', 'VM', 'XX'].includes(leg.path)) break;
      if (leg.fix && (endpoints.has(leg.path) || holds.has(leg.path))) return leg.fix;
    }
    return undefined;
  };

  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i]!, fix = leg.fix;
    if (leg.missed && !missedStarted) {
      if (position && anchor !== undefined && !chain) landingEnd = anchor;
      if (chain) gap(i, 'inconsistent-constraints', 'The landing path has an unresolved end.');
      missedStarted = true; phase = 'missed';
    }
    if (!position && fix && (leg.path === 'IF' || i === 0 || endpoints.has(leg.path) || holds.has(leg.path))) {
      atFix(fix, leg);
      // Selecting or recovering an anchor does not establish an arrival course.
      course = undefined; courseLeg = undefined;
      if (leg.path === 'IF' || endpoints.has(leg.path)) continue;
    }
    if (leg.path === 'IF') {
      if (!fix) gap(i, 'missing-reference', 'A published fix is unavailable.');
      else {
        if (position && !same(position, fix.coordinate)) gap(i, 'inconsistent-constraints', 'The procedure branches do not connect at the same fix.');
        atFix(fix, leg);
      }
      continue;
    }
    if (['FM', 'VM'].includes(leg.path)) { gap(i, 'manual-termination', 'This leg has no fixed endpoint; follow the plate and ATC instructions.'); continue; }
    if (!position) { gap(i, 'missing-reference', 'The start of this maneuver is unavailable.'); continue; }
    const start = position;
    if (holds.has(leg.path)) {
      if (!fix) { gap(i, 'missing-reference', 'The holding fix is unavailable.'); continue; }
      if (!same(start, fix.coordinate)) gap(i, 'inconsistent-constraints', 'The path to the holding fix is unresolved.');
      const inbound = resolvedCourse(leg), index = atFix(fix, leg), point = points[index]!;
      point.hold = leg.turn ?? 'unknown';
      if (leg.missed) point.missed = true;
      if (leg.holdMinutes !== undefined) point.holdLength = `${leg.holdMinutes} MIN`;
      else if (leg.distance !== undefined) point.holdLength = `${leg.distance} NM`;
      if (inbound !== undefined) point.holdCourse = inbound;
      const effective = { ...leg, ...(inbound === undefined ? {} : { trueCourse: inbound }) };
      const pattern = holdingPattern(effective, procedure);
      if (pattern) spans.push({ kind: 'schematic', symbol: 'hold', phase, from: index, to: index, ...pattern,
        legs: [i], sources: leg.id ? [leg.id] : [], assumptions: ['holding-pattern'] });
      else issue(i, 'missing-reference', 'Holding course, turn or length is unavailable.');
      course = inbound; courseLeg = leg;
      continue;
    }
    if (['CA', 'VA', 'FA'].includes(leg.path)) {
      const h = resolvedCourse(leg), target = nextEndpoint(i);
      if (h === undefined || !target || leg.path === 'FA' && !fix) { gap(i, 'missing-reference', 'The climb course or following endpoint is unavailable.'); continue; }
      const distance = distanceNm(start, target.coordinate);
      const length = (distance < .5 ? approachSchematicPolicy.climbNm : Math.min(approachSchematicPolicy.climbNm, Math.max(.5, distance / 4))) * climbScale;
      const turn = course === undefined ? [start] : turnToHeading(start, course, h, leg.turn, Math.min(.7, length / 2));
      append(i, [...turn, destination(turn.at(-1)!, h, length)], ['altitude-dependent', ...(turn.length > 1 ? ['turn-radius'] : [])], phase === 'missed' ? 'missed' : 'intercept');
      course = h; courseLeg = leg; continue;
    }
    if (leg.path === 'FC') {
      let h = resolvedCourse(leg);
      // Older exports lack station references. Two surveyed endpoints and matching
      // courses/lengths can still constrain their shared track without a guessed datum.
      const next = legs[i + 1];
      const bounded = !leg.reference && next ? courseFromFix(leg, next, procedure) : undefined;
      if (bounded) h = bearing(bounded[0]!, bounded.at(-1)!);
      if (!fix || !same(start, fix.coordinate) || h === undefined || !leg.distance) {
        gap(i, 'missing-reference', 'The outbound course, start or distance is unavailable.'); continue;
      }
      if (leg.trueCourse === undefined && leg.reference?.declination === undefined && !bounded) {
        gap(i, 'missing-reference', 'The outbound course reference is unavailable.'); continue;
      }
      append(i, [start, destination(start, h, leg.distance)]);
      course = h; courseLeg = leg; continue;
    }
    if (['CI', 'VI'].includes(leg.path)) {
      const next = legs[i + 1], h = resolvedCourse(leg);
      if (leg.fix || !next?.fix || next.path !== 'CF' || Boolean(next.missed) !== Boolean(leg.missed) || h === undefined) {
        gap(i, 'missing-reference', 'The intercept heading or following inbound course is unavailable.'); continue;
      }
      let coordinates: Coordinate[] | undefined;
      for (const radius of [.7, .35, .15, .05]) {
        const turn = course === undefined ? [start] : turnToHeading(start, course, h, leg.turn, radius);
        const join = courseIntercept(turn.at(-1)!, { ...leg, trueCourse: h }, next, procedure);
        if (join) { coordinates = [...turn, ...join.slice(1)]; break; }
      }
      if (!coordinates) { gap(i, 'no-forward-intersection', 'The courses have no bounded forward intercept.'); continue; }
      const climb = chain?.legs.length === 1 ? legs[chain.legs[0]!] : undefined;
      const departureSegment = chain ? chain.coordinates.length - 2 : -1;
      const climbAltitude = climb && altitudeFloor(climb), returnAltitude = altitudeFloor(next);
      append(i, coordinates, ['turn-radius', ...(leg.path === 'VI' ? ['no-wind-heading'] : [])], chain?.symbol ?? 'intercept');
      chain!.legs.push(i + 1);
      if (next.id) chain!.sources.push(next.id);
      // A directed missed intercept can return to a station across the initial
      // straight climb. Permit only that segment pair; crossings in either turn
      // or elsewhere in the path still require review. The CF endpoint/course
      // and forward intersection have already been enforced above.
      if (phase === 'missed' && climb?.missed && leg.missed && next.missed && ['CA', 'VA', 'FA'].includes(climb.path) && leg.turn &&
          climbAltitude !== undefined && returnAltitude !== undefined && returnAltitude > climbAltitude &&
          next.reference?.type === 'navaid' && next.reference.coordinate && next.reference.declination !== undefined &&
          same(next.fix.coordinate, next.reference.coordinate) && departureSegment >= 0) {
        climbReturns.set(chain!, [departureSegment, chain!.coordinates.length - 2]);
      }
      course = approachCourse(next, procedure); courseLeg = next;
      atFix(next.fix, next); i++; continue;
    }
    if (['CR', 'VR', 'CD', 'VD', 'FD'].includes(leg.path)) {
      const h = resolvedCourse(leg), reference = leg.reference;
      const radial = leg.path.endsWith('R');
      const center = radial ? reference?.coordinate : reference?.dmeCoordinate;
      if (h === undefined || !center || radial && (leg.radial === undefined || reference?.declination === undefined) || !radial && !leg.distance) {
        gap(i, 'missing-reference', radial ? 'The radial or its station reference is unavailable.' : 'The DME distance or station reference is unavailable.'); continue;
      }
      const turn = course === undefined ? [start] : turnToHeading(start, course, h, leg.turn);
      const end = radial ? rayIntersection(turn.at(-1)!, h, center, leg.radial! + reference!.declination!)
        : rangeIntersection(turn.at(-1)!, h, center, leg.distance!);
      if (!end) { gap(i, 'no-forward-intersection', 'The course does not reach its radial or DME termination.'); continue; }
      append(i, [...turn, end], ['turn-radius', ...(leg.path.startsWith('V') ? ['no-wind-heading'] : []),
        ...(radial ? [] : ['DME-plan-view'])], phase === 'missed' ? 'missed' : 'intercept');
      course = h; courseLeg = leg; continue;
    }
    if (leg.path === 'PI') {
      let nextIndex = i + 1;
      while (legs[nextIndex]?.path === 'IF' && fix && legs[nextIndex]?.fix && same(fix.coordinate, legs[nextIndex]!.fix!.coordinate)) nextIndex++;
      const next = legs[nextIndex];
      const inbound = next?.path === 'CF' && Boolean(next.missed) === Boolean(leg.missed) ? approachCourse(next, procedure) : undefined;
      if (!fix || !same(start, fix.coordinate) || !next?.fix || inbound === undefined || !leg.turn || !leg.distance || leg.magneticCourse === undefined || next.magneticCourse === undefined) {
        gap(i, 'missing-reference', 'The procedure-turn side, extent or inbound course is unavailable.'); continue;
      }
      const outbound = (inbound + 180) % 360, breakaway = (inbound + difference(leg.magneticCourse, next.magneticCourse) + 360) % 360;
      // PI terminates by intercepting the next leg, which can end outside the
      // starting fix. Extend the illustrative outbound portion when the next
      // inbound fix is behind the start, while retaining the published extent.
      const behind = distanceNm(start, next.fix.coordinate) * Math.cos(difference(bearing(start, next.fix.coordinate), outbound) * Math.PI / 180);
      const length = Math.max(Math.min(3, leg.distance / 3), behind > .05 ? behind + Math.min(1, leg.distance / 5) : 0);
      const margin = leg.distance - length;
      const radius = Math.min(.4, leg.distance / 20, Math.max(.01, margin / 4));
      const a = destination(start, outbound, length);
      const first = turnToHeading(a, outbound, breakaway, leg.turn === 'R' ? 'L' : 'R', radius);
      const b = destination(first.at(-1)!, breakaway, Math.min(1.5, length / 2, Math.max(.01, margin / 2)));
      const reverse = turnToHeading(b, breakaway, breakaway + 180, leg.turn, radius);
      const join = courseIntercept(reverse.at(-1)!, { path: 'CI', trueCourse: (breakaway + 180) % 360 },
        next, procedure);
      const coordinates = join && [start, a, ...first.slice(1), b, ...reverse.slice(1), ...join.slice(1)];
      // The CF endpoint can lie beyond the PI extent after course capture.
      if (!coordinates || coordinates.slice(0, -1).some(p => distanceNm(start, p) > leg.distance! + .1)) {
        gap(i, 'inconsistent-constraints', 'A bounded procedure turn cannot join the inbound course.'); continue;
      }
      append(i, coordinates, ['procedure-turn'], 'procedure-turn');
      for (let j = i + 1; j <= nextIndex; j++) {
        chain!.legs.push(j);
        if (legs[j]!.id) chain!.sources.push(legs[j]!.id!);
      }
      course = inbound; courseLeg = next; atFix(next.fix, next); i = nextIndex; continue;
    }
    if (endpoints.has(leg.path)) {
      if (!fix) { gap(i, 'missing-reference', 'The terminating fix is unavailable.'); continue; }
      // Tenths-of-a-mile FC encoding can terminate just short of the next surveyed
      // CF fix. Snap within half the source distance precision, without adding a
      // tiny, arbitrary-course segment or treating the CF distance as additive.
      if (leg.path === 'CF' && legs[i - 1]?.path === 'FC' && chain &&
          distanceNm(start, fix.coordinate) < approachSchematicPolicy.endpointToleranceNm) {
        chain.legs.push(i); chain.coordinates[chain.coordinates.length - 1] = fix.coordinate;
        if (leg.id) chain.sources.push(leg.id);
        course = arrivalBearing(chain.coordinates.at(-2)!, fix.coordinate) ?? course;
        courseLeg = leg; atFix(fix, leg); continue;
      }
      const inbound = resolvedCourse(leg), assumed = chain?.kind === 'schematic';
      let coordinates: Coordinate[] | undefined, assumptions: string[] = [];
      if (['AF', 'RF'].includes(leg.path)) {
        coordinates = leg.center && leg.turn && (leg.path !== 'AF' || leg.radiusNm !== undefined)
          ? radiusArc(start, fix.coordinate, leg.center, leg.turn, leg.path === 'AF' ? leg.radiusNm : undefined) : undefined;
      } else if (same(start, fix.coordinate)) coordinates = [start, fix.coordinate];
      else if (assumed || leg.path === 'DF' && leg.turn && course !== undefined) {
        coordinates = leg.path === 'CF' && inbound !== undefined ? joinCourse(start, course ?? bearing(start, fix.coordinate), fix.coordinate, inbound, leg.turn)
          : turnToFix(start, course ?? bearing(start, fix.coordinate), fix.coordinate, leg.turn);
        assumptions = ['turn-radius'];
      } else if (leg.path === 'CF' && inbound !== undefined && distanceNm(start, fix.coordinate) > approachSchematicPolicy.endpointToleranceNm &&
          Math.abs(difference(arrivalBearing(start, fix.coordinate)!, inbound)) > 10) {
        coordinates = joinCourse(start, course ?? bearing(start, fix.coordinate), fix.coordinate, inbound, leg.turn);
        assumptions = ['course-capture'];
      } else coordinates = [start, fix.coordinate];
      if (!coordinates) { gap(i, 'inconsistent-constraints', 'The coded course, arc or turn cannot connect these endpoints.'); atFix(fix, leg); continue; }
      append(i, coordinates, assumptions);
      course = ['AF', 'RF'].includes(leg.path) && leg.center && leg.turn
        ? (bearing(leg.center, fix.coordinate) + (leg.turn === 'R' ? 90 : 270)) % 360
        : coordinates.length > 1 ? arrivalBearing(coordinates.at(-2)!, coordinates.at(-1)!) ?? inbound ?? course : inbound ?? course;
      courseLeg = leg; atFix(fix, leg); continue;
    }
    gap(i, 'unsupported-leg', 'This maneuver cannot be depicted from the available data.');
  }
  if (chain) gap(legs.length - 1, 'missing-reference', 'The maneuver has no terminating fix.');
  for (const span of spans) if (span.kind === 'schematic' && span.symbol !== 'hold' && span.symbol !== 'procedure-turn') {
    const last = legs[span.legs.at(-1)!];
    // A prescribed direct return can cross the departing track. The circular
    // turn/tangent construction already enforces that turn and its endpoint.
    if (last?.path === 'DF' && last.turn && selfCrosses(span.coordinates) && !selfCrosses(span.coordinates.slice(0, -1))) {
      span.assumptions.push('direct-return'); continue;
    }
    if (selfCrosses(span.coordinates)) {
      const permitted = climbReturns.get(span);
      if (permitted && !selfCrosses(span.coordinates, permitted)) span.assumptions.push('climb-return');
      else issue(span.legs[0]!, 'geometry-review', 'The schematic path crosses itself and needs review.');
    }
    const length = span.coordinates.slice(1).reduce((sum, p, i) => sum + distanceNm(span.coordinates[i]!, p), 0);
    if (!span.assumptions.includes('altitude-dependent') && length > 2 * distanceNm(span.coordinates[0]!, span.coordinates.at(-1)!) + 3)
      issue(span.legs[0]!, 'geometry-review', 'The schematic path takes a long detour and needs review.');
  }
  const segments: ApproachPreview['segments'] = spans.flatMap(s => s.kind === 'fixed' && s.from !== undefined && s.to !== undefined
    ? [{ from: s.from, to: s.to, coordinates: s.coordinates, phase: s.phase }] : []);
  const depictions: ApproachDepiction[] = spans.flatMap(s => s.kind === 'schematic' ? [{ kind: s.symbol ?? 'intercept', phase: s.phase, coordinates: s.coordinates,
    ...(s.arrow ? { arrow: s.arrow } : {}) }] : []);
  const exit = position && !chain ? anchor : undefined;
  if (!missedStarted) landingEnd = exit;
  return { points, spans, issues, segments, depictions, incomplete: issues.length > 0, policy: { version: approachSchematicPolicy.version, climbScale },
    ...(exit === undefined ? {} : { exit }), ...(landingEnd === undefined ? {} : { landingEnd }) };
}
