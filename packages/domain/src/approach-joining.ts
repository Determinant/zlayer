import type { ApproachLeg, ApproachRoute } from '@zlayer/contracts';
import { approachCourse, bearing } from './approach-geometry.js';
import { difference } from './approach-path-geometry.js';
import { distanceNm } from './route.js';

/** Join a feeder to the inbound approach, never to a later missed occurrence of
 * the same fix. A reversal may reference a station lying on the inbound course
 * instead of one of the final branch's named fixes. */
export function joinApproachTransition(procedure: ApproachRoute, legs: ApproachLeg[], visited = new Set<string>()): ApproachLeg[] {
  const last = legs.at(-1), end = last?.fix;
  const final = procedure.final;
  const faf = final.findIndex(l => !l.missed && l.fix?.role === 'FAF');
  let junction = end ? final.findIndex(l => !l.missed && l.fix?.ident === end.ident &&
    distanceNm(l.fix.coordinate, end.coordinate) < .01) : -1;
  if (last?.path === 'PI' && faf >= 0 && junction > faf) junction = -1;
  if (junction < 0 && last && !last.missed) {
    if (last.path === 'CI' && !last.fix && last.magneticCourse !== undefined && final[0]?.path === 'IF' &&
        final[1]?.path === 'CF' && !final[0].missed && !final[1].missed) {
      // The initial fix defines the intercepted course's origin; CI terminates
      // on that course, not necessarily at its origin.
      junction = 1;
    } else if (end && ['PI', 'HF'].includes(last.path) && last.reference && last.magneticCourse !== undefined) {
      for (let i = 0; i <= faf; i++) {
        const next = final[i]!, course = approachCourse(next, procedure);
        if (next.missed || next.path !== 'CF' || !next.fix || next.reference?.id !== last.reference.id || course === undefined) continue;
        // Matching reference plus a bounded cross-track offset identifies the
        // published inbound course; nearby fixes alone are insufficient.
        const d = distanceNm(next.fix.coordinate, end.coordinate);
        const angle = difference(bearing(next.fix.coordinate, end.coordinate), course + 180) * Math.PI / 180;
        const cross = Math.abs(Math.sin(angle) * d), before = Math.cos(angle) * d;
        if (cross > .2 || d > (last.path === 'PI' ? last.distance ?? 0 : 25)) continue;
        if (last.path === 'HF' && (before < -.05 || next.magneticCourse === undefined ||
            Math.abs(difference(last.magneticCourse, next.magneticCourse)) > 1)) continue;
        // Keep intermediate fixes within the PI extent as well as the FAF. A
        // station inside final can reverse outside those fixes before capture.
        if (last.path === 'PI' || before >= -.05) { junction = i; break; }
      }
    }
  }
  if (junction < 0 && end && last && ['IF', 'TF', 'CF', 'DF'].includes(last.path)) {
    // Some feeders end at another transition's IAF. Follow only one explicit
    // continuation, preserving its source legs and refusing ambiguity/cycles.
    const onward = procedure.transitions.filter(t => !visited.has(t.id) && t.legs.length > 1 &&
      t.legs[0]?.path === 'IF' && t.legs[0].fix?.ident === end.ident &&
      distanceNm(t.legs[0].fix.coordinate, end.coordinate) < .01);
    if (onward.length === 1) {
      const next = onward[0]!;
      return joinApproachTransition(procedure, [...legs, ...next.legs.slice(1)], new Set([...visited, next.id]));
    }
  }
  return [...legs, ...(junction >= 0 ? final.slice(junction) : [{ path: 'XX' }, ...final])];
}
