import { VerticalSpeedDisplay, type VerticalSpeedReading } from './vertical-speed';

/** Display-only animation adapted from the standalone zlayer-ahrs demo. */
export interface InstrumentFix {
  /** Monotonic seconds, on the same clock as update(now). */
  time: number;
  /** Meters and meters/second, as supplied by GPS. */
  altitude: number | null;
  speed: number | null;
  /** GPS vertical accuracy in meters, when supplied. */
  altitudeAccuracy?: number | null;
}

export const METERS_PER_FOOT = 0.3048;
export const METERS_PER_KNOT_SECOND = 1852 / 3600;
export const MPH_PER_KNOT = 1852 / 1609.344;

export interface InstrumentValues {
  altitudeFeet: number | null;
  groundspeedKnots: number | null;
  verticalSpeed: VerticalSpeedReading | null;
}

/** Display-only tracker. Sensor samples and estimator/recording data stay raw. */
class AnimatedReading {
  private value: number | null = null;
  private velocity = 0;
  private observation: { value: number; time: number } | null = null;
  private rate = 0;
  constructor(
    private readonly maxRate: number,
    private readonly jump: number,
  ) {}

  reset(): void {
    this.value = null;
    this.velocity = 0;
    this.observation = null;
    this.rate = 0;
  }

  update(
    value: number | null,
    time: number,
    age: number,
    dt: number,
  ): number | null {
    if (value === null || !Number.isFinite(value)) {
      this.reset();
      return null;
    }
    const previous = this.observation;
    if (
      this.value === null ||
      !previous ||
      time < previous.time ||
      Math.abs(value - previous.value) > this.jump
    ) {
      this.value = value;
      this.velocity = 0;
      this.rate = 0;
      this.observation = { value, time };
      return value;
    }
    if (time > previous.time) {
      const elapsed = time - previous.time;
      this.rate =
        elapsed >= 0.1 && elapsed <= 2.5
          ? Math.max(
              -this.maxRate,
              Math.min(this.maxRate, (value - previous.value) / elapsed),
            )
          : 0;
      this.observation = { value, time };
    }
    // Predict for at most one normal GPS interval, then stop. Expired/missing
    // inputs are cleared by InstrumentDisplay instead of animated indefinitely.
    const horizon = 1.25;
    const target = value + this.rate * Math.min(horizon, Math.max(0, age));
    const targetRate = age >= 0 && age < horizon ? this.rate : 0;
    // Exact critically damped spring solution for a linearly moving target.
    // Keeps position and velocity continuous when a new fix arrives.
    const omega = 12;
    const error = this.value - (target - targetRate * dt);
    const relativeVelocity = this.velocity - targetRate;
    const coefficient = relativeVelocity + omega * error;
    const decay = Math.exp(-omega * dt);
    this.value = target + (error + coefficient * dt) * decay;
    this.velocity =
      targetRate + (relativeVelocity - omega * coefficient * dt) * decay;
    return this.value;
  }
}

/** One per mounted instrument panel, driven by the animation frame clock. */
export class InstrumentDisplay {
  private altitude = new AnimatedReading(100, 2000);
  private speed = new AnimatedReading(15, 100);
  private verticalSpeed = new VerticalSpeedDisplay();
  private last: number | null = null;

  reset(): void {
    this.altitude.reset();
    this.speed.reset();
    this.verticalSpeed.reset();
    this.last = null;
  }

  update(fix: InstrumentFix | null, now: number): InstrumentValues {
    const dt = this.last === null ? 0 : now - this.last;
    if (dt < 0 || dt > 0.5) this.reset();
    this.last = now;
    const age = fix ? now - fix.time : Infinity;
    const gps = age >= -0.1 && age <= 3 ? fix : null;
    const step = Math.max(0, Math.min(dt, 0.5));
    const speed = this.speed.update(
      gps?.speed == null ? null : gps.speed / METERS_PER_KNOT_SECOND,
      gps?.time ?? 0,
      age,
      step,
    );
    return {
      altitudeFeet: this.altitude.update(
        gps?.altitude == null ? null : gps.altitude / METERS_PER_FOOT,
        gps?.time ?? 0,
        age,
        step,
      ),
      groundspeedKnots: speed === null ? null : Math.max(0, speed),
      verticalSpeed: this.verticalSpeed.update(
        gps?.altitude == null ? null : gps.altitude / METERS_PER_FOOT,
        gps?.time ?? 0, now, gps?.altitudeAccuracy ?? null,
      ),
    };
  }
}

export interface DrumColumn {
  digits: number;
  current: string;
  next: string;
  previous: string;
  nextNext?: string;
  phase: number;
}

/** Mechanical drum columns, least significant first. Carry propagates one digit
 * at a time, as in loupe-flightdeck's mechanicalStyleNumber. Reserve leading
 * space before a carry so 9,980→10,000 ft and 99→100 kt never clip or wrap.
 */
export function mechanicalColumns(
  value: number,
  step: 1 | 20,
  minimumDigits: number,
): DrumColumn[] {
  if (!Number.isFinite(value)) throw new RangeError("Invalid instrument value");
  const magnitude = Math.abs(value);
  const lowDigits = step === 20 ? 2 : 1;
  const base = 10 ** lowDigits;
  const bucket = Math.floor((magnitude % base) / step);
  const phase = (magnitude % step) / step;
  const count = base / step;
  const format = (n: number) =>
    String(((n + count) % count) * step).padStart(lowDigits, "0");
  const columns: DrumColumn[] = [
    {
      digits: lowDigits,
      current: format(bucket),
      next: format(bucket + 1),
      previous: format(bucket - 1),
      nextNext: format(bucket + 2),
      phase,
    },
  ];
  // Include an upcoming leading digit throughout its carry, rather than adding
  // it abruptly after crossing a power of ten.
  const next = (Math.floor(magnitude / step) + 1) * step;
  const digits = Math.max(
    minimumDigits,
    Math.floor(Math.log10(Math.max(1, next))) + 1,
  );
  let carry = bucket === count - 1 ? phase : 0;
  for (let place = lowDigits; place < digits; place++) {
    const power = 10 ** place;
    const digit = Math.floor(magnitude / power) % 10;
    const leading = magnitude < power;
    columns.push({
      digits: 1,
      current: leading ? "" : String(digit),
      next: leading && carry === 0 ? "" : String((digit + 1) % 10),
      previous: leading ? "" : String((digit + 9) % 10),
      phase: carry,
    });
    if (digit !== 9) carry = 0;
  }
  return columns;
}
