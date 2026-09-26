import { add, scale, sub, type Vec3 } from './math.js';
import type { ImuSample } from './types.js';

/** Separate short-period scatter from the slowly changing sensor mean.
 * Raw samples still drive propagation/fusion; these statistics only increase
 * observation uncertainty and qualify steady readings for reacquisition.
 */
export class ImuNoise {
  private time: number | null = null;
  private force: Vec3 = [0, 0, 0];
  private gyro: Vec3 = [0, 0, 0];
  private variance: Vec3 = [0, 0, 0];

  reset(): void { this.time = null; this.variance = [0, 0, 0]; }

  observe(sample: ImuSample) {
    const dt = this.time === null ? 0 : sample.time - this.time;
    this.time = sample.time;
    if (dt <= 0) {
      this.force = [...sample.specificForce];
      this.gyro = [...sample.gyro];
    } else {
      const gain = -Math.expm1(-dt / .25), noiseGain = -Math.expm1(-dt / .5);
      this.force = add(this.force, scale(sub(sample.specificForce, this.force), gain));
      this.gyro = add(this.gyro, scale(sub(sample.gyro, this.gyro), gain));
      const residual = sub(sample.specificForce, this.force);
      this.variance = this.variance.map((value, axis) => value + noiseGain * (residual[axis]! ** 2 - value)) as unknown as Vec3;
    }
    return { force: this.force, gyro: this.gyro, variance: Math.max(...this.variance) };
  }
}
