export type VerticalSpeedReading = { feetPerMinute: number; roundedFeetPerMinute: number };

/** GPS-altitude trend for display only. Never differentiate animated drums or
 * unaided inertial vertical velocity: neither is a measured climb rate. */
export class VerticalSpeedDisplay {
  private samples: { time: number; feet: number }[] = [];
  private target: number | null = null;
  private filtered: number | null = null;
  private rounded = 0;
  private last: number | null = null;

  reset(): void {
    this.samples = [];
    this.target = this.filtered = this.last = null;
    this.rounded = 0;
  }

  update(feet: number | null, time: number, now: number, accuracy: number | null = null): VerticalSpeedReading | null {
    if (feet === null || !Number.isFinite(feet) || !Number.isFinite(time) ||
      (accuracy !== null && (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 30))) {
      this.reset();
      return null;
    }
    // Advance the previous target before observing a new fix. The damping is
    // exponential in elapsed time, independent of the display's frame rate.
    const dt = this.last === null ? 0 : now - this.last;
    if (this.filtered !== null && this.target !== null) {
      this.filtered += (this.target - this.filtered) * -Math.expm1(-Math.max(0, dt) / 2);
    }
    this.last = now;
    const previous = this.samples.at(-1);
    if (previous && (time < previous.time || time - previous.time > 2.5 ||
      (time > previous.time && Math.abs(feet - previous.feet) / (time - previous.time) > 200))) {
      // A clock reset, gap, or implausible altitude step starts a new trend.
      this.reset();
      this.last = now;
    }
    const latest = this.samples.at(-1);
    if (!latest || time - latest.time >= .2 - 1e-6) {
      this.samples.push({ time, feet });
      this.samples = this.samples.filter(sample => time - sample.time <= 5);
      const span = time - this.samples[0]!.time;
      if (this.samples.length >= 3 && span >= 2) {
        const count = this.samples.length;
        const tMean = this.samples.reduce((sum, sample) => sum + sample.time - time, 0) / count;
        const hMean = this.samples.reduce((sum, sample) => sum + sample.feet, 0) / count;
        let numerator = 0, denominator = 0;
        for (const sample of this.samples) {
          const t = sample.time - time - tMean;
          numerator += t * (sample.feet - hMean);
          denominator += t * t;
        }
        this.target = numerator / denominator * 60;
        this.filtered ??= this.target;
      }
    }
    if (this.filtered === null) return null;
    // 100-fpm steps with a 25-fpm hysteresis margin prevent flicker at rounding
    // boundaries; a small zero band keeps level-flight digits quiet.
    if (Math.abs(this.filtered) < 75) this.rounded = 0;
    else if ((this.rounded !== 0 || Math.abs(this.filtered) >= 100) && Math.abs(this.filtered - this.rounded) >= 75) {
      this.rounded = Math.sign(this.filtered) * Math.round(Math.abs(this.filtered) / 100) * 100;
    }
    return { feetPerMinute: this.filtered, roundedFeetPerMinute: this.rounded };
  }
}
