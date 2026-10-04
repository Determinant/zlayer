import { GPS_MOTION_ACCURACY_METERS, GPS_MOTION_SAMPLE_MS, validSpeed, type GpsFix } from '../../core/gps/position';

const EARTH_RADIUS = 6_371_008.8;
const RADIANS = Math.PI / 180;
const TURN_WINDOW_SECONDS = 6;
const TURN_MIN_SPAN_SECONDS = 3;
const TURN_MAX_GAP_SECONDS = 2.5;
const MAX_TURN_RATE = 12; // degrees per second; reject track discontinuities
const TRACK_VECTOR_SECONDS = 60;
const TRACK_VECTOR_MAX_TURN = 90; // degrees
// Subtracting fractional acquisition seconds can put an exact boundary just
// below its threshold. Tolerate roundoff without rounding fixes or filter gains.
export const MOTION_TIME_EPSILON_SECONDS = 1e-9;
const wrap = (angle: number) => (angle % 360 + 360) % 360;
const difference = (a: number, b: number) => wrap(a - b + 180) - 180;
const fade = (value: number, low: number, high: number) => {
  const t = Math.max(0, Math.min(1, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
};

/** Keep longitude near the origin so a dateline crossing draws the short path. */
export function destination(from: [number, number], track: number, meters: number): [number, number] {
  const lat = from[1] * RADIANS, direction = track * RADIANS, angle = meters / EARTH_RADIUS;
  const endLat = Math.asin(Math.max(-1, Math.min(1,
    Math.sin(lat) * Math.cos(angle) + Math.cos(lat) * Math.sin(angle) * Math.cos(direction))));
  const endLon = from[0] + Math.atan2(Math.sin(direction) * Math.sin(angle) * Math.cos(lat),
    Math.cos(angle) - Math.sin(lat) * Math.sin(endLat)) / RADIANS;
  return [endLon, endLat / RADIANS];
}

type MovingGpsFix = GpsFix & { track: number; speed: number };

export function usableMotion(fix: GpsFix): fix is MovingGpsFix {
  return fix.accuracy <= GPS_MOTION_ACCURACY_METERS && fix.track !== null && Number.isFinite(fix.track) &&
    fix.track >= 0 && fix.track < 360 && validSpeed(fix.speed) && fix.speed >= 1;
}

/** Fit chronological GPS ground tracks over a continuous recent window; clockwise positive, in degrees/second. */
export function estimateTurnRate(fix: GpsFix, history: readonly GpsFix[]): number | null {
  if (!usableMotion(fix)) return null;
  const samples = [{ time: 0, angle: 0 }];
  let newer = fix, angle = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const sample = history[i]!;
    if (fix.time - sample.time > TURN_WINDOW_SECONDS + MOTION_TIME_EPSILON_SECONDS) break;
    const elapsed = newer.time - sample.time;
    if (elapsed <= 0) continue;
    // Do not bridge outages, stopped/unknown motion or changes of velocity source.
    if (elapsed > TURN_MAX_GAP_SECONDS + MOTION_TIME_EPSILON_SECONDS || !usableMotion(sample) || sample.estimated !== fix.estimated) break;
    // Match retained sample spacing: a rounded heading over a few milliseconds
    // must not look like an impossible turn. Still check continuity above.
    if (elapsed < GPS_MOTION_SAMPLE_MS / 1000 - MOTION_TIME_EPSILON_SECONDS) continue;
    const change = ((newer.track - sample.track + 540) % 360) - 180;
    if (Math.abs(change / elapsed) > MAX_TURN_RATE) break;
    angle -= change;
    samples.push({ time: sample.time - fix.time, angle });
    newer = sample;
  }
  if (fix.time - newer.time < TURN_MIN_SPAN_SECONDS - MOTION_TIME_EPSILON_SECONDS) return null;
  // Least-squares slope of unwrapped track against elapsed seconds.
  const meanTime = samples.reduce((sum, sample) => sum + sample.time, 0) / samples.length;
  const meanAngle = samples.reduce((sum, sample) => sum + sample.angle, 0) / samples.length;
  let covariance = 0, variance = 0;
  for (const sample of samples) {
    covariance += (sample.time - meanTime) * (sample.angle - meanAngle);
    variance += (sample.time - meanTime) ** 2;
  }
  const rate = covariance / variance;
  const oldest = samples.at(-1)!, middleTime = oldest.time / 2;
  const middleIndex = samples.findIndex(sample => sample.time <= middleTime);
  const before = samples[middleIndex]!, after = samples[middleIndex - 1]!;
  const middleAngle = before.angle + (after.angle - before.angle) * (middleTime - before.time) / (after.time - before.time);
  // Both halves must support the same turn. A short left/right wobble can
  // otherwise have a steep regression slope, especially on high-rate feeds.
  // A one-minute extrapolation magnifies a tiny or inconsistent heading trend.
  // Fade confidence in continuously instead of switching full curvature on/off
  // at a threshold. Even tiny heading noise otherwise moves the endpoint ~1 km.
  // RMS (not standard error) avoids pretending high-rate callbacks are independent.
  const residual = Math.sqrt(samples.reduce((sum, sample) =>
    sum + (sample.angle - meanAngle - rate * (sample.time - meanTime)) ** 2, 0) / samples.length);
  const travel = Math.abs(rate) * (fix.time - newer.time);
  const direction = Math.sign(rate);
  const consistentTravel = Math.min(direction * (middleAngle - oldest.angle), direction * -middleAngle) * 2;
  const confidence = Math.min(fade(Math.abs(rate), .3, 1), fade(consistentTravel, 0, 3),
    fade(travel, 3 * residual, 3 * residual + 1.5));
  return confidence === 0 ? 0 : rate * confidence;
}

export type DisplayMotion = { displayTrack: number | null; turnRate: number | null };

/** Presentation only: never change the observed position, velocity or timestamp.
 * Elapsed-time damping behaves consistently on 1 Hz and high-rate GPS feeds. */
export function smoothMotion(fix: GpsFix, previous: DisplayMotion & { fix: GpsFix | null }, rate: number | null): DisplayMotion {
  const before = previous.fix;
  if (!usableMotion(fix)) return { displayTrack: fix.track, turnRate: null };
  const seconds = before ? fix.time - before.time : Infinity;
  if (!before || !usableMotion(before) || before.estimated !== fix.estimated || seconds > TURN_MAX_GAP_SECONDS + MOTION_TIME_EPSILON_SECONDS
    || seconds <= 0 || previous.displayTrack === null) return { displayTrack: fix.track, turnRate: null };
  const gain = -Math.expm1(-seconds / 2);
  return {
    displayTrack: wrap(previous.displayTrack + gain * difference(fix.track, previous.displayTrack)),
    turnRate: rate === null ? null : (previous.turnRate ?? 0) + gain * (rate - (previous.turnRate ?? 0)),
  };
}

/** A 60-second track vector, clipped at 90° of turn as on the G1000. */
export function projectedTrack(fix: GpsFix, turnRate: number | null = null, displayTrack = fix.track): [number, number][] {
  if (!usableMotion(fix)) return [];
  const { speed } = fix, track = displayTrack ?? fix.track;
  const rate = turnRate !== null && Number.isFinite(turnRate) && Math.abs(turnRate) <= MAX_TURN_RATE ? turnRate : 0;
  const seconds = rate === 0 ? TRACK_VECTOR_SECONDS : Math.min(TRACK_VECTOR_SECONDS, TRACK_VECTOR_MAX_TURN / Math.abs(rate));
  // At most five seconds or three degrees per segment keeps the vector smooth.
  const steps = Math.max(Math.ceil(seconds / 5), Math.ceil(Math.abs(rate) * seconds / 3));
  return Array.from({ length: steps + 1 }, (_, index) => {
    // Ownship and the vector origin are always the measured position.
    if (index === 0) return fix.coordinates;
    const time = seconds * index / steps;
    const halfAngle = rate * time * RADIANS / 2;
    // Chord of a constant-speed, constant-turn-rate arc in the local ground plane.
    const meters = speed * time * (halfAngle === 0 ? 1 : Math.sin(halfAngle) / halfAngle);
    return destination(fix.coordinates, track + rate * time / 2, meters);
  });
}
