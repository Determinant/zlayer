import type { HeadingSample } from '../../core/map/heading';

const wrap = (value: number) => (value % 360 + 360) % 360;
const difference = (a: number, b: number) => wrap(a - b + 180) - 180;
const BEARING_DEADBAND_DEGREES = 2;
const GPS_CORRECTION_SECONDS = 3;
const MAP_BEARING_SECONDS = 1.5;

/** Event-driven display filter. GPS owns the reference; sensors supply only
 * relative rotation. No extrapolation, timers, or changes to aircraft geometry. */
export class TrackBearing {
  private value: number | null = null;
  private filtered: number | null = null;
  private filterTime: number | null = null;
  private target: number | null = null;
  private gps: { track: number; time: number } | null = null;
  private sensor: HeadingSample | null = null;
  private history: { time: number; angle: number }[] = [];

  reset(): void {
    this.value = this.filtered = this.filterTime = this.target = this.gps = null;
    this.clearSensor();
  }
  clearSensor(): void { this.sensor = null; this.history = []; }
  read(): number | null { return this.target; }
  private commit(time: number, seed = false): void {
    if (this.value === null) return;
    if (seed || this.filtered === null || this.filterTime === null) {
      this.filtered = this.value;
      this.filterTime = time;
      this.target = wrap(this.value);
      return;
    }
    // Smooth the final GPS/sensor bearing independently of reference correction.
    // Use elapsed sample time, including across north, not a per-callback gain.
    // Delayed GPS updates must not rewind or advance the display clock twice.
    if (time > this.filterTime) {
      this.filtered += difference(this.value, this.filtered) * -Math.expm1(-(time - this.filterTime) / MAP_BEARING_SECONDS);
      this.filterTime = time;
    }
    if (this.target === null || Math.abs(difference(this.filtered, this.target)) >= BEARING_DEADBAND_DEGREES) {
      this.target = wrap(this.filtered);
    }
  }
  observeGps(track: number, time: number): void {
    if (!Number.isFinite(track) || !Number.isFinite(time) || (this.gps && time <= this.gps.time)) return;
    const previous = this.gps, value = this.value;
    this.gps = { track, time };
    const seed = value === null || !previous || time - previous.time > 3;
    if (seed) {
      this.value = track;
      this.clearSensor();
    } else {
      // Match a delayed fix to its acquisition-time sensor rotation, rather than
      // pulling the map backwards to where it was when the fix was measured.
      let travel = 0;
      const latest = this.history.at(-1);
      if (latest && time >= this.history[0]!.time && time <= latest.time) {
        for (let i = 1; i < this.history.length; i++) {
          const a = this.history[i - 1]!, b = this.history[i]!;
          if (time <= b.time) {
            travel = latest.angle - (a.angle + (b.angle - a.angle) * (time - a.time) / (b.time - a.time));
            break;
          }
        }
      }
      const error = difference(track + travel, value);
      const aided = this.sensor && Math.abs(time - this.sensor.time) <= .5;
      // Correct substantial GPS-only errors promptly; the final map filter
      // still damps their display. Sensors supply relative turns separately.
      const tau = aided ? GPS_CORRECTION_SECONDS : Math.abs(error) > 10 ? .3 : 1.5;
      this.value = value + error * -Math.expm1(-(time - previous.time) / tau);
    }
    this.commit(Math.max(time, this.history.at(-1)?.time ?? time), seed);
  }
  observeHeading(sample: HeadingSample | null, now: number): void {
    if (!sample) { this.clearSensor(); return; }
    if (!Number.isFinite(sample.degrees) || !Number.isFinite(sample.time) || now - sample.time > .5 || sample.time > now + .1) return;
    const previous = this.sensor;
    if (previous && sample.time <= previous.time) return;
    this.sensor = sample;
    const dt = previous ? sample.time - previous.time : Infinity;
    const delta = previous ? difference(sample.degrees, previous.degrees) : 0;
    if (!previous || previous.frame !== sample.frame || dt > .5 || Math.abs(delta) > 45 * dt) {
      this.history = [{ time: sample.time, angle: 0 }];
      return;
    }
    const angle = (this.history.at(-1)?.angle ?? 0) + delta;
    this.history.push({ time: sample.time, angle });
    while (this.history.length > 1 && this.history[1]!.time < sample.time - 3) this.history.shift();
    if (this.value === null || !this.gps || now - this.gps.time > 3) return;
    // A moved device or drifting sensor cannot carry the map indefinitely away
    // from measured track while waiting for the next GPS correction.
    const offset = difference(this.value, this.gps.track);
    // GPS damping can already be outside this band after a new track arrives.
    // Bound additional sensor motion without snapping that GPS correction.
    const next = Math.max(Math.min(offset, -15), Math.min(Math.max(offset, 15), offset + delta));
    this.value += next - offset;
    this.commit(sample.time);
  }
}
