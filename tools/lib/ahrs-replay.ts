import { ESTIMATOR_MODEL } from '../../src/layers/ahrs/estimator/state-layout';
import { Ahrs } from '../../src/layers/ahrs/estimator/ahrs';
import type { AhrsGpsSource, AhrsSnapshot } from '../../src/layers/ahrs/layer';
import type { FlightAlignmentSolution } from '../../src/layers/ahrs/estimator/flight-alignment';
import { rotate, type Quaternion } from '../../src/layers/ahrs/estimator/math';
import type { AhrsOptions, Attitude, ImuSample, MagneticSample, Observation } from '../../src/layers/ahrs/estimator/types';

export type RecordedEvent = { sequence: number; time: number; type: string; data: unknown };
export type ReplayOutput = { type: string; time: number; data: unknown };

export function parseRecordingLine(line: string): RecordedEvent {
  const value = JSON.parse(line, (_, value: unknown) => value === 'Infinity' ? Infinity
    : value === '-Infinity' ? -Infinity : value === 'NaN' ? NaN : value) as RecordedEvent;
  if (!value || !Number.isInteger(value.sequence) || !Number.isFinite(value.time) ||
    typeof value.type !== 'string' || value.data === undefined) throw new Error('Invalid recording event');
  return value;
}

/** Replay estimator inputs in receipt order, using their own acquisition times.
 * Starts from each recorded calibration solution; it does not certify calibration
 * or invent the missing history of a recording started mid-flight.
 */
export async function replayAhrs(events: AsyncIterable<RecordedEvent> | Iterable<RecordedEvent>,
  output: (event: ReplayOutput) => void = () => {}) {
  let sequence = 0, receipt = 0, segments = 0, samples = 0, gps = 0, comparisons = 0;
  let maxAttitudeDifference = 0, maxCovarianceDifference = 0, ended = false;
  let options: AhrsOptions = {}, filter: Ahrs | null = null, trim: Quaternion = [1, 0, 0, 0];
  let previousHeading = '', magneticMessage = '';
  // Replayed innovations replace older versions; never count both in statistics.
  const innovations = new Map<string, Observation>();
  const requireFilter = () => {
    if (!filter) throw new Error('No recorded alignment before applied input. Start recording before calibration.');
    return filter;
  };
  const emit = (type: string, data: unknown) => output({ type, time: receipt, data });
  for await (const event of events) {
    if (event.sequence !== sequence++) throw new Error(`Recording sequence gap at ${event.sequence}`);
    receipt = event.time;
    if (sequence === 1 && event.type !== 'header') throw new Error('Recording header missing');
    if (event.type === 'header') {
      const header = event.data as { format: string; version: number; context: { estimatorModel?: string; estimatorOptions?: AhrsOptions } };
      if (sequence !== 1 || header.format !== 'zlayer-ahrs' || header.version !== 1 || !header.context)
        throw new Error('Unsupported recording format');
      if (header.context.estimatorModel !== ESTIMATOR_MODEL)
        throw new Error(`Unsupported estimator model: ${header.context.estimatorModel ?? "legacy 15-state"}. Replay with its original estimator revision.`);
      options = { ...header.context.estimatorOptions };
    } else if (event.type === 'calibrate' || event.type === 'stop') {
      filter = null; magneticMessage = '';
    } else if (event.type === 'alignment') {
      const { solution, trueHeading } = event.data as { solution: FlightAlignmentSolution; trueHeading: number | null };
      trim = solution.levelTrim;
      if (!Array.isArray(trim) || trim.length !== 4 || !trim.every(Number.isFinite) || Math.abs(Math.hypot(...trim) - 1) > 1e-6)
        throw new Error('Invalid recorded mount trim');
      segments++;
      filter = new Ahrs(options, observation => {
        innovations.set(`${segments}:${observation.source}:${observation.time}`, observation);
        emit('innovation', observation);
      });
      const bias = rotate(trim, solution.gyroBias);
      filter.setGyroBias(bias, solution.gyroBiasStd);
      filter.update({ time: solution.time, gyro: bias, specificForce: rotate(trim, solution.specificForce) });
      if (trueHeading != null) filter.alignHeading(trueHeading);
      if (magneticMessage) filter.magneticUnavailable(magneticMessage);
    } else if (event.type === 'imu') {
      const { sample, phase, applied } = event.data as { sample: ImuSample; phase: string; applied: boolean };
      // Honor old recordings' explicitly skipped samples as well as new full-rate recordings.
      if (phase === 'ready' && applied) {
        requireFilter().update({ time: sample.time, gyro: rotate(trim, sample.gyro), specificForce: rotate(trim, sample.specificForce) });
        samples++;
      }
    } else if (event.type === 'gps') {
      const data = event.data as ReturnType<AhrsGpsSource['getSnapshot']> & { time: number; forwarded: boolean };
      if (data.forwarded) {
        if (!data.fix) throw new Error('Forwarded GPS is missing its fix');
        requireFilter().updateGps({ time: data.time, speed: data.fix.speed, track: data.fix.track,
          accuracy: data.fix.accuracy, estimated: data.fix.estimated, altitude: data.fix.altitude ?? null, altitudeAccuracy: data.fix.altitudeAccuracy ?? null });
        gps++;
      }
    } else if (event.type === 'magnetic') {
      const { sample, forwarded } = event.data as { sample: MagneticSample; forwarded: boolean };
      magneticMessage = '';
      if (forwarded) requireFilter().updateMagnetic(sample);
    } else if (event.type === 'magnetic-issue') {
      magneticMessage = (event.data as { reason: string }).reason;
      filter?.magneticUnavailable(magneticMessage);
    } else if (event.type === 'state' && filter) {
      const recorded = (event.data as AhrsSnapshot).attitude, actual = filter.getState(receipt);
      if (recorded) {
        // Quaternion chord distance avoids acos precision loss for identical results.
        const q = actual.quaternion, r = recorded.quaternion;
        const chord = Math.min(Math.hypot(...q.map((x, i) => x - r[i]!)), Math.hypot(...q.map((x, i) => x + r[i]!)));
        maxAttitudeDifference = Math.max(maxAttitudeDifference, 4 * Math.asin(Math.min(1, chord / 2)) * 180 / Math.PI);
        comparisons++;
      }
      emit('state', actual);
    } else if (event.type === 'covariance' && filter) {
      const recorded = event.data as number[], actual = filter.getCovariance();
      if (!Array.isArray(recorded) || recorded.length !== actual.length || !recorded.every(Number.isFinite))
        throw new Error('Invalid recorded covariance');
      recorded.forEach((value, i) => { maxCovarianceDifference = Math.max(maxCovarianceDifference, Math.abs(value - actual[i]!)); });
    } else if (event.type === 'end') ended = true;
    if (filter) {
      const state: Attitude = filter.getState(receipt), heading = `${segments}:${state.headingStatus}:${state.headingReference}`;
      if (heading !== previousHeading) {
        emit('heading', { status: state.headingStatus, source: state.headingReference, reason: state.headingReason });
        previousHeading = heading;
      }
    }
  }
  if (!segments) throw new Error('No recorded alignment. Start recording before calibration.');
  const statistics = (['velocity', 'velocity-change', 'altitude', 'tilt', 'magnetic'] as const).map(source => {
    const values = [...innovations.values()].filter(value => value.source === source && value.nis !== null);
    const dimensions = values.reduce((sum, value) => sum + value.dimension, 0);
    return { source, observations: values.length, rejected: values.filter(value => value.result !== 'accepted').length,
      normalizedNis: dimensions ? values.reduce((sum, value) => sum + value.nis!, 0) / dimensions : null };
  });
  const summary = { segments, samples, gps, comparisons, ended, maxAttitudeDifference, maxCovarianceDifference, statistics };
  emit('summary', summary);
  return summary;
}
