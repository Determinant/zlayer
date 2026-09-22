export const GPS_STALE_MS = 10_000;
export const GPS_MOTION_ACCURACY_METERS = 100;
export const GPS_MOTION_SAMPLE_MS = 100;
// A generous aviation sanity bound, also applied to inferred motion so location
// provider jumps cannot turn into an enormous vector or overflow its geometry.
export const GPS_MAX_SPEED_METERS_PER_SECOND = 1500;
const EARTH_RADIUS = 6_371_008.8;
const RADIANS = Math.PI / 180;

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

export function validSpeed(speed: number | null): speed is number {
  return speed !== null && Number.isFinite(speed) && speed >= 0 && speed <= GPS_MAX_SPEED_METERS_PER_SECOND;
}
