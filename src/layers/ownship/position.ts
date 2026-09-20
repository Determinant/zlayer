export const GPS_STALE_MS = 10_000;
export const GPS_MOTION_ACCURACY_METERS = 100;
export const GPS_MOTION_SAMPLE_MS = 100;
// A generous aviation sanity bound, also applied to inferred motion so location
// provider jumps cannot turn into an enormous vector or overflow its geometry.
export const GPS_MAX_SPEED_METERS_PER_SECOND = 1500;
const EARTH_RADIUS = 6_371_008.8;
const RADIANS = Math.PI / 180;
const TURN_WINDOW_MS = 3000;
const TURN_MIN_SPAN_MS = 1000;
const TURN_MAX_GAP_MS = 2500;
const MAX_TURN_RATE = 12; // degrees per second; reject track discontinuities
const TURN_RATE_DEADBAND = 0.1; // degrees per second
const TRACK_VECTOR_SECONDS = 60;
const TRACK_VECTOR_MAX_TURN = 90; // degrees

export type GpsFix = {
  coordinates: [number, number];
  accuracy: number;
  timestamp: number;
  track: number | null;
  speed: number | null;
  altitude: number | null;
  altitudeAccuracy: number | null;
  estimated: boolean;
};

/** Browser heading is course over ground, clockwise from true north. */
export function readGpsFix(
  position: GeolocationPosition, previous: GpsFix | null, now: number, motionOrigin: GpsFix | null = previous,
): GpsFix | null {
  const { latitude, longitude, accuracy, heading, speed, altitude, altitudeAccuracy } = position.coords;
  const timestamp = position.timestamp;
  if (![latitude, longitude, accuracy, timestamp].every(Number.isFinite) || Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180 || accuracy < 0 || timestamp > now + 1000 || now - timestamp >= GPS_STALE_MS ||
    (previous && timestamp <= previous.timestamp)) return null;
  const fix: GpsFix = { coordinates: [longitude, latitude], accuracy, timestamp,
    speed: validSpeed(speed) ? speed : null,
    altitude: altitude != null && Number.isFinite(altitude) ? altitude : null,
    altitudeAccuracy: altitudeAccuracy != null && Number.isFinite(altitudeAccuracy) && altitudeAccuracy >= 0 ? altitudeAccuracy : null,
    track: heading !== null && Number.isFinite(heading) && heading >= 0 && heading < 360 ? heading : null,
    estimated: false };
  if (accuracy > GPS_MOTION_ACCURACY_METERS) return { ...fix, track: null, speed: null };
  // Some devices provide positions but omit velocity. Derive only from movement
  // larger than both fixes' uncertainty, never from stationary GPS jitter.
  if (motionOrigin && motionOrigin.accuracy <= GPS_MOTION_ACCURACY_METERS && (fix.speed === null || fix.track === null)) {
    const seconds = (timestamp - motionOrigin.timestamp) / 1000;
    const distance = distanceMeters(motionOrigin.coordinates, fix.coordinates);
    if (seconds >= 1 && seconds <= GPS_STALE_MS / 1000 && validSpeed(distance / seconds) &&
      distance > Math.max(5, accuracy + motionOrigin.accuracy)) {
      if (fix.speed === null) { fix.speed = distance / seconds; fix.estimated = true; }
      if (fix.track === null && fix.speed >= 1) {
        // Use the arrival bearing, expressed in the current fix's north frame.
        fix.track = (bearing(fix.coordinates, motionOrigin.coordinates) + 180) % 360;
        fix.estimated = true;
      }
    }
  }
  if (fix.speed !== null && fix.speed < 1) fix.track = null;
  return fix;
}

export function distanceMeters(from: [number, number], to: [number, number]): number {
  const lat1 = from[1] * RADIANS, lat2 = to[1] * RADIANS;
  const a = Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) *
    Math.sin((to[0] - from[0]) * RADIANS / 2) ** 2;
  return EARTH_RADIUS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}

function bearing(from: [number, number], to: [number, number]): number {
  const lat1 = from[1] * RADIANS, lat2 = to[1] * RADIANS, lon = (to[0] - from[0]) * RADIANS;
  return (Math.atan2(Math.sin(lon) * Math.cos(lat2),
    Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon)) / RADIANS + 360) % 360;
}

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

function usableMotion(fix: GpsFix): fix is MovingGpsFix {
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
    if (fix.timestamp - sample.timestamp > TURN_WINDOW_MS) break;
    const elapsed = newer.timestamp - sample.timestamp;
    if (elapsed <= 0) continue;
    // Do not bridge outages, stopped/unknown motion or changes of velocity source.
    if (elapsed > TURN_MAX_GAP_MS || !usableMotion(sample) || sample.estimated !== fix.estimated) break;
    // Match retained sample spacing: a rounded heading over a few milliseconds
    // must not look like an impossible turn. Still check continuity above.
    if (elapsed < GPS_MOTION_SAMPLE_MS) continue;
    const change = ((newer.track - sample.track + 540) % 360) - 180;
    if (Math.abs(change * 1000 / elapsed) > MAX_TURN_RATE) break;
    angle -= change;
    samples.push({ time: (sample.timestamp - fix.timestamp) / 1000, angle });
    newer = sample;
  }
  if (fix.timestamp - newer.timestamp < TURN_MIN_SPAN_MS) return null;
  // Least-squares slope of unwrapped track against elapsed seconds.
  const meanTime = samples.reduce((sum, sample) => sum + sample.time, 0) / samples.length;
  const meanAngle = samples.reduce((sum, sample) => sum + sample.angle, 0) / samples.length;
  let covariance = 0, variance = 0;
  for (const sample of samples) {
    covariance += (sample.time - meanTime) * (sample.angle - meanAngle);
    variance += (sample.time - meanTime) ** 2;
  }
  const rate = covariance / variance;
  return Math.abs(rate) < TURN_RATE_DEADBAND ? 0 : rate;
}

/** A 60-second track vector, clipped at 90° of turn as on the G1000. */
export function projectedTrack(fix: GpsFix, turnRate: number | null = null): [number, number][] {
  if (!usableMotion(fix)) return [];
  const { track, speed } = fix;
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

function validSpeed(speed: number | null): speed is number {
  return speed !== null && Number.isFinite(speed) && speed >= 0 && speed <= GPS_MAX_SPEED_METERS_PER_SECOND;
}
