import { G, RAD, finiteVector, norm, sub, type Vec3 } from '../math.js';
import type { GpsFix, GroundDiagnostics, ImuSample } from '../types.js';

// Browser adaptation of PX4's separate landed/rest qualification. These are
// conservative operating assumptions, not a replacement for airspeed/arming data.
const GPS_AGE = 2.5, STOP_SPEED = .5, MOVE_SPEED = 1;
const TAXI_SPEED = 3.5; // PX4's 5 m/s landed limit × 0.7 without airspeed.
const LAND_TIME = 5, REST_TIME = 1;
// Limits from PX4's land detector. Browser sample-difference metrics do not
// reproduce its integrated IMU cadence or filtered angular-velocity output.
const GYRO_VIBRATION = .02, ACCEL_VIBRATION = 1.2;
type GpsEvidence = { time: number; speed: number | null; vertical: number | null };

export class GroundState {
  private gps: { time: number; speed: number; smoothed: number; vertical: number | null } | null = null;
  private pendingGps: GpsEvidence[] = [];
  private gpsTime = -Infinity;
  private previous: ImuSample | null = null;
  private meanRate: Vec3 = [0, 0, 0];
  private meanForce: Vec3 = [0, 0, -G];
  private gyroVibration = 0;
  private accelVibration = 0;
  private stoppedSince: number | null = null;
  private quietSince: number | null = null;
  private landed = false;
  private diagnostics: GroundDiagnostics | undefined;

  reset(): void {
    this.gps = null; this.gpsTime = -Infinity; this.previous = null;
    this.pendingGps = [];
    this.clearQualification();
    this.gyroVibration = this.accelVibration = 0;
    this.diagnostics = undefined;
  }

  getDiagnostics(): GroundDiagnostics | undefined {
    return this.diagnostics && { ...this.diagnostics };
  }

  private clearQualification(): void {
    this.stoppedSince = this.quietSince = null;
    this.landed = false;
  }

  observeGps(fix: GpsFix): void {
    const velocity = fix.velocityNed && finiteVector(fix.velocityNed) ? fix.velocityNed : null;
    const speed = velocity ? Math.hypot(velocity[0], velocity[1]) : fix.speed;
    const usable = !fix.estimated && fix.accuracy <= 10 && speed !== null && Number.isFinite(speed) && speed >= 0;
    this.enqueue({ time: fix.time, speed: usable ? speed : null, vertical: velocity ? Math.abs(velocity[2]) : null });
  }

  invalidate(time: number): void { this.enqueue({ time, speed: null, vertical: null }); }

  private enqueue(fix: GpsEvidence): void {
    if (fix.time <= this.gpsTime) return;
    this.gpsTime = fix.time; // A rejected fix must still supersede older evidence.
    // Keep the applicable fix while older IMU callbacks are still queued.
    // A prolonged motion pause must not accumulate unbounded GPS history.
    if (this.pendingGps.length >= 32) {
      this.pendingGps = []; this.gps = null;
      this.clearQualification();
    }
    this.pendingGps.push(fix);
  }

  private applyGps(fix: GpsEvidence): void {
    const { speed, vertical } = fix;
    if (speed === null) {
      this.gps = null;
      this.clearQualification();
      return;
    }
    const previous = this.gps, dt = previous ? fix.time - previous.time : Infinity;
    const smoothed = previous && dt <= GPS_AGE
      ? previous.smoothed + -Math.expm1(-dt / 2) * (speed - previous.smoothed) : speed;
    this.gps = { time: fix.time, speed, smoothed, vertical };
    // Preserve release evidence even when several fixes precede one IMU callback.
    if (dt > GPS_AGE || speed > TAXI_SPEED || vertical !== null && vertical >= 1) this.clearQualification();
    if (speed > STOP_SPEED || smoothed > STOP_SPEED) this.stoppedSince = null;
    if (speed > MOVE_SPEED || smoothed > STOP_SPEED) this.quietSince = null;
  }

  update(sample: ImuSample, bias: Vec3): { atRest: boolean; inAir: boolean } {
    const previous = this.previous, dt = previous ? sample.time - previous.time : 0;
    const rate = sub(sample.gyro, bias);
    if (!previous || dt > .25) {
      this.meanRate = rate; this.meanForce = sample.specificForce;
      this.gyroVibration = this.accelVibration = 0;
      this.clearQualification();
    } else {
      const alpha = -Math.expm1(-dt / .5);
      const mean = (a: Vec3, b: Vec3): Vec3 => [
        a[0] + alpha * (b[0] - a[0]), a[1] + alpha * (b[1] - a[1]), a[2] + alpha * (b[2] - a[2]),
      ];
      this.meanRate = mean(this.meanRate, rate);
      this.meanForce = mean(this.meanForce, sample.specificForce);
      this.gyroVibration += alpha * (norm(sub(sample.gyro, previous.gyro)) - this.gyroVibration);
      this.accelVibration += alpha * (norm(sub(sample.specificForce, previous.specificForce)) - this.accelVibration);
    }
    this.previous = sample;
    while (this.pendingGps.length && this.pendingGps[0]!.time <= sample.time) this.applyGps(this.pendingGps.shift()!);
    const gps = this.gps;
    const fresh = gps && sample.time >= gps.time && sample.time - gps.time <= GPS_AGE;
    const forceDeviation = Math.abs(norm(this.meanForce) - G);
    const levelForce = forceDeviation < .15 * G;
    const verticalQuiet = gps?.vertical === null || (gps?.vertical ?? Infinity) < 1;
    const stopped = fresh && gps.speed <= STOP_SPEED && gps.smoothed <= STOP_SPEED && verticalQuiet && levelForce;
    this.stoppedSince = stopped ? this.stoppedSince ?? sample.time : null;
    if (!fresh || gps.speed > TAXI_SPEED || !verticalQuiet || !levelForce) this.landed = false;
    else if (this.stoppedSince !== null && sample.time - this.stoppedSince >= LAND_TIME) this.landed = true;

    // Release from raw movement evidence; smoothing is only used to qualify entry.
    const angularRate = norm(rate), meanAngularRate = norm(this.meanRate);
    const rateQuiet = angularRate <= 3 * RAD, meanRateQuiet = meanAngularRate <= .5 * RAD;
    const gyroQuiet = this.gyroVibration <= GYRO_VIBRATION, accelQuiet = this.accelVibration <= ACCEL_VIBRATION;
    const quiet = this.landed && fresh && gps.speed <= MOVE_SPEED && gps.smoothed <= STOP_SPEED
      && rateQuiet && meanRateQuiet && gyroQuiet && accelQuiet;
    this.quietSince = quiet ? this.quietSince ?? sample.time : null;
    const stoppedFor = this.stoppedSince === null ? 0 : sample.time - this.stoppedSince;
    const quietFor = this.quietSince === null ? 0 : sample.time - this.quietSince;
    const atRest = this.quietSince !== null && quietFor >= REST_TIME;
    this.diagnostics = {
      time: sample.time,
      reason: !fresh ? 'Waiting for fresh, reported GPS speed'
        : !verticalQuiet ? 'Vertical motion above rest limit' : !levelForce ? 'Mean force outside rest range'
        : gps.speed > (this.landed ? MOVE_SPEED : STOP_SPEED) || gps.smoothed > STOP_SPEED ? 'GPS speed above rest limit'
        : !rateQuiet ? 'Rotation above 3°/s' : !meanRateQuiet ? 'Mean rotation above 0.5°/s'
        : !gyroQuiet ? 'Gyro vibration above rest limit' : !accelQuiet ? 'Acceleration vibration above rest limit'
        : !this.landed ? 'Qualifying ground stop (5 s)' : atRest ? 'Rest qualified' : 'Qualifying rest (1 s)',
      gpsAge: gps ? sample.time - gps.time : Infinity,
      speed: gps?.speed ?? null, smoothedSpeed: gps?.smoothed ?? null, verticalSpeed: gps?.vertical ?? null,
      forceDeviation, angularRate, meanAngularRate,
      gyroVibration: this.gyroVibration, accelVibration: this.accelVibration, stoppedFor, quietFor,
    };
    return { inAir: !this.landed, atRest };
  }
}
