import type { AirportRunway, AirportRunwayEnd } from '@zlayer/contracts';

export type RunwayHeading = { degrees: number; reference: 'magnetic' | 'true'; estimated: boolean };

/** Legacy summaries still identify ends even without per-end metadata. */
export function runwayEnds(runway: AirportRunway): AirportRunwayEnd[] {
  return runway.ends?.length ? runway.ends : runway.id.split('/').map(id => ({ id }));
}

/** Published magnetic, published true, then an explicitly approximate runway-number bearing. */
export function runwayHeading(end: AirportRunwayEnd, magneticAvailable = true): RunwayHeading | undefined {
  if (magneticAvailable && validHeading(end.magneticHeadingDeg)) {
    return { degrees: end.magneticHeadingDeg, reference: 'magnetic', estimated: false };
  }
  if (validHeading(end.trueHeadingDeg)) {
    return { degrees: end.trueHeadingDeg, reference: 'true', estimated: false };
  }
  if (!magneticAvailable) return undefined;
  // Accept numeric runway designators and FAA end suffixes, not helipad/compass names.
  const match = /^(\d{2}|\d)(?:[LRCWGSU]|\d)?$/.exec(end.id);
  const number = match ? Number(match[1]) : 0;
  return number >= 1 && number <= 36
    ? { degrees: number * 10, reference: 'magnetic', estimated: true } : undefined;
}

export type RunwayWind = {
  direction: string | number | null | undefined;
  speedKt: number | null | undefined;
  gustKt?: number | null | undefined;
};

export type RunwayWindComponents =
  | { kind: 'calm' }
  | { kind: 'variable'; speedKt: number; gustKt?: number }
  | { kind: 'unavailable'; reason: 'speed' | 'direction' | 'heading' }
  | {
      kind: 'directional';
      /** Positive is headwind; negative is tailwind. */
      headwindKt: number;
      /** Positive is wind FROM the right; negative is FROM the left. */
      crosswindKt: number;
      gust?: { headwindKt: number; crosswindKt: number };
    };

/** Runway heading and wind FROM direction must use the same north reference (true or magnetic). */
export function runwayWindComponents(
  headingDeg: number | undefined,
  wind: RunwayWind,
): RunwayWindComponents {
  const speed = wind.speedKt;
  if (!validSpeed(speed)) return { kind: 'unavailable', reason: 'speed' };
  const gust = validSpeed(wind.gustKt) && wind.gustKt > speed ? wind.gustKt : undefined;
  if (speed === 0 && gust === undefined) return { kind: 'calm' };
  if (typeof wind.direction === 'string' && wind.direction.trim().toUpperCase() === 'VRB') {
    return { kind: 'variable', speedKt: speed, ...(gust === undefined ? {} : { gustKt: gust }) };
  }
  const direction = typeof wind.direction === 'string' && /^\d{1,3}$/.test(wind.direction.trim())
    ? Number(wind.direction) : wind.direction;
  if (!validHeading(direction)) return { kind: 'unavailable', reason: 'direction' };
  if (!validHeading(headingDeg)) return { kind: 'unavailable', reason: 'heading' };
  const angle = (direction - headingDeg) * Math.PI / 180;
  const components = (knots: number) => ({
    headwindKt: cleanZero(knots * Math.cos(angle)),
    crosswindKt: cleanZero(knots * Math.sin(angle)),
  });
  return {
    kind: 'directional', ...components(speed),
    ...(gust === undefined ? {} : { gust: components(gust) }),
  };
}

function validSpeed(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validHeading(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 360;
}

function cleanZero(value: number): number {
  return Math.abs(value) < 1e-10 ? 0 : value;
}
