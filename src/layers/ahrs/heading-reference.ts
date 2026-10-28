import { RAD, wrap } from './estimator/math';
import type { Attitude } from './estimator/types';
import { DEFAULTS } from './estimator/ahrs';

export type HsiHeading = { degrees: number; source: 'gps' | 'ahrs' };
const difference = (a: number, b: number) => wrap(a - b + 180) - 180;
const aligned = (attitude: Attitude | null) => attitude?.headingStatus === 'tracking' &&
  ['tracking', 'coasting', 'degraded'].includes(attitude.status) && Number.isFinite(attitude.yaw);

/** Session-owned geographic display reference. GPS supplies a provisional north
 * reference; calibrated gyro motion carries it between fixes. This does not turn
 * ground track into a trusted heading measurement in the navigation filter. */
export class HeadingReference {
  private carrier = 0;
  private previous: { time: number; attitude: Attitude } | null = null;
  private history: { time: number; angle: number }[] = [];
  private correction: { time: number; from: number; to: number; source: HsiHeading['source'] } | null = null;
  private pending: { time: number; track: number } | null = null;
  private lastGps = -Infinity;

  reset(heading?: number, now = 0): void {
    this.carrier = 0;
    this.previous = this.correction = this.pending = null;
    this.history = [];
    this.lastGps = -Infinity;
    if (heading !== undefined) this.target(heading, 0, now, 'ahrs');
  }

  private offset(now: number): number {
    const c = this.correction;
    if (!c) return 0;
    // Stop pursuing an old observation after its useful lifetime. Reading the
    // display is pure, so stowing/remounting never resets or advances this state.
    const elapsed = Math.max(0, Math.min(3, now - c.time));
    return c.to + (c.from - c.to) * Math.exp(-elapsed / (c.source === 'gps' ? 5 : 1));
  }

  private target(degrees: number, carrier: number, now: number, source: HsiHeading['source']): void {
    const from = this.offset(now), to = from + difference(degrees, carrier + from);
    this.correction = { time: now, from: this.correction ? from : to, to, source };
  }

  observeImu(time: number, attitude: Attitude, now: number): void {
    const previous = this.previous;
    if (previous && time <= previous.time) return;
    if (previous) {
      const dt = time - previous.time;
      if (dt <= DEFAULTS.maxGap && Math.abs(Math.cos(previous.attitude.pitch * RAD)) >= .1 &&
        Math.abs(Math.cos(attitude.pitch * RAD)) >= .1 && attitude.status !== 'interrupted' &&
        Number.isFinite(attitude.unaidedYaw) && Number.isFinite(previous.attitude.unaidedYaw)) {
        // PX4 already integrated these readings with bias and coning correction.
        // Its unaided yaw excludes navigation-frame resets and aiding jumps.
        this.carrier += difference(attitude.unaidedYaw!, previous.attitude.unaidedYaw!);
      } else this.history = []; // Never interpolate or integrate through a motion gap.
    }
    this.previous = { time, attitude };
    this.history.push({ time, angle: this.carrier });
    while (this.history.length > 1 && this.history[1]!.time < time - 3) this.history.shift();
    this.observeAttitude(attitude, now);
    this.applyGps(now);
  }

  observeAttitude(attitude: Attitude, now: number): void {
    if (aligned(attitude)) {
      this.pending = null;
      this.target(attitude.yaw, this.carrier, now, 'ahrs');
    }
  }

  /** Caller supplies only fresh, accurate, non-estimated track above the movement gate. */
  observeGps(time: number, track: number, now: number, attitude: Attitude | null): void {
    if (!Number.isFinite(track) || time <= this.lastGps) return;
    this.lastGps = time;
    if (attitude && aligned(attitude)) {
      this.observeAttitude(attitude, now);
      return;
    }
    this.pending = { time, track };
    this.applyGps(now);
  }

  private applyGps(now: number): void {
    const fix = this.pending;
    if (!fix) return;
    if (now - fix.time > 3) { this.pending = null; return; }
    const latest = this.history.at(-1);
    if (latest && fix.time > latest.time && now - latest.time <= DEFAULTS.maxGap) return;
    this.pending = null;
    let carrier = this.carrier;
    // With paused motion, GPS can still establish/update an estimate under the
    // Motion cross. Do not invent rotation across the missing IMU interval.
    if (latest && fix.time <= latest.time) {
      if (fix.time < this.history[0]!.time) return;
      for (let i = 1; i < this.history.length; i++) {
        const a = this.history[i - 1]!, b = this.history[i]!;
        if (fix.time <= b.time) {
          carrier = a.angle + (b.angle - a.angle) * (fix.time - a.time) / (b.time - a.time);
          break;
        }
      }
    }
    this.target(fix.track, carrier, now, 'gps');
  }

  read(now: number): HsiHeading | null {
    return this.correction ? { degrees: wrap(this.carrier + this.offset(now)), source: this.correction.source } : null;
  }
}
