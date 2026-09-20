import { cloneState, N, predictInterval, releaseHeadingCovariance, restartNavigation, tiltStd, type NavState } from './eskf.js';
import { RAD, add, norm, scale, sub, toEuler, type Vec3 } from './math.js';
import { identity, product, type Matrix } from './linalg.js';
import { MotionHeading } from './motion-heading.js';
import type { AhrsOptions, GpsFix, ImuSample } from './types.js';

type Point = { state: NavState; sample: ImuSample; transition: Matrix };

/** Independent inertial evidence for global heading acquisition/recovery.
 * Navigation corrections never bend this trajectory. A seed copies the current
 * tilt/bias marginal once; subsequent samples propagate its own uncertainty.
 * Retain acquisition-time checkpoints to match delayed GPS without extrapolation.
 */
export class HeadingTrajectory {
  private readonly fit = new MotionHeading();
  private history: Point[] = [];
  private last: Point | null = null;
  private started = -Infinity;
  private awaitingFreshForce = true;
  private rotationRate: Vec3 = [0, 0, 0];
  private lastRotation = -Infinity;

  constructor(private readonly config: Required<AhrsOptions>) {}

  reset(state?: NavState, sample?: ImuSample): void {
    this.fit.reset();
    this.history = [];
    this.last = null;
    this.awaitingFreshForce = true;
    this.rotationRate = [0, 0, 0];
    this.lastRotation = -Infinity;
    this.started = sample?.time ?? -Infinity;
    if (!state || !sample) return;
    const seed = restartNavigation(state, [...state.q], this.config);
    // Absolute yaw is the fit's unknown global rotation, not a Gaussian prior.
    releaseHeadingCovariance(state, seed);
    this.last = { state: seed, sample, transition: identity(N) };
    this.history.push({ state: cloneState(seed), sample, transition: identity(N) });
  }

  /** Refresh quiet trajectories, but retain a turn through delayed GPS and the
   * three confirmation fixes. A hard cap still bounds uninterrupted maneuvers. */
  needsRefresh(now: number): boolean {
    const age = now - this.started;
    return age > 60 || (age > 30 && now - this.lastRotation > 10);
  }

  update(sample: ImuSample): void {
    if (!this.last || sample.time <= this.last.sample.time) return;
    const gain = -Math.expm1(-(sample.time - this.last.sample.time) / .5);
    this.rotationRate = add(this.rotationRate, scale(sub(sub(sample.gyro, this.last.state.bg), this.rotationRate), gain));
    if (norm(this.rotationRate) > .02) this.lastRotation = sample.time;
    if (this.awaitingFreshForce) {
      // The seed may already be conditioned on its current force reading in the
      // main filter. Do not reuse that reading as independent process noise.
      // Carry attitude to the next fresh sample, then start translation there.
      predictInterval(this.last.state, { ...this.last.sample, specificForce: [0, 0, 0] },
        sample.time - this.last.sample.time, this.config);
      const seed = restartNavigation(this.last.state, this.last.state.q, this.config);
      releaseHeadingCovariance(this.last.state, seed);
      this.last = { state: seed, sample, transition: identity(N) };
      this.history = [{ state: cloneState(seed), sample, transition: identity(N) }];
      this.started = sample.time;
      this.awaitingFreshForce = false;
      return;
    }
    const last = this.last;
    predictInterval(last.state, last.sample, sample.time - last.sample.time, this.config,
      phi => { last.transition = product(phi, last.transition, N, N, N); });
    this.last.sample = sample;
    this.history.push({ state: cloneState(this.last.state), sample, transition: this.last.transition.slice() });
    const cutoff = sample.time - this.config.historySeconds;
    let remove = 0;
    while (remove + 1 < this.history.length && this.history[remove + 1]!.sample.time <= cutoff) remove++;
    if (remove) this.history.splice(0, remove);
  }

  observe(fix: GpsFix): { headingDegrees: number; headingStdDegrees: number } | null {
    if (this.awaitingFreshForce || !this.last || !this.history.length || fix.time < this.history[0]!.sample.time || fix.time > this.last.sample.time) return null;
    let before = this.history[0]!;
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i]!.sample.time <= fix.time) { before = this.history[i]!; break; }
    }
    const state = cloneState(before.state);
    let transition: Matrix = before.transition.slice();
    predictInterval(state, before.sample, fix.time - before.sample.time, this.config,
      phi => { transition = product(phi, transition, N, N, N); });
    if (tiltStd(state) > 10) { this.fit.reset(); return null; }
    const alignment = this.fit.observe(fix, { state, transition }, this.last, this.config.gpsVelocityStd);
    if (!alignment) return null;
    // Transport the fitted rotation to NOW using this trajectory's quaternion,
    // never the main filter's yaw (which other accepted aids may have changed).
    return { headingDegrees: (toEuler(this.last.state.q).yaw + alignment.offsetRadians) / RAD,
      headingStdDegrees: alignment.headingStdDegrees };
  }
}
