export interface MotionTime {
  time: number;
  receivedTime: number;
  clock: 'event' | 'epoch-event';
}

/** DOM timestamps describe event creation, not guaranteed hardware acquisition.
 * They avoid adding callback queue latency to integration. Delayed delivery does
 * not imply missing samples; consumers judge freshness/gaps by the event times.
 * Never reconstruct missing samples or silently switch to receipt time.
 * All arguments are milliseconds; returned times share performance.timeOrigin.
 */
export class MotionClock {
  private previous = -Infinity;

  /** Null means a duplicate/out-of-order reading with no new integration interval. */
  read(timestamp: number, received: number, origin: number): MotionTime | null {
    const clock = timestamp >= 1e12 ? 'epoch-event' : 'event';
    const time = (clock === 'epoch-event' ? timestamp - origin : timestamp) / 1000;
    const receivedTime = received / 1000;
    const invalid = (detail: string) => new Error(`Skipped motion reading: ${detail}. Waiting for fresh readings.`);
    if (!Number.isFinite(time) || !Number.isFinite(receivedTime) || time < 0 || receivedTime < 0)
      throw invalid('non-finite or negative timestamp');
    if (time > receivedTime + .002)
      throw invalid(`timestamp is ${((time - receivedTime) * 1000).toFixed(1)} ms ahead of receipt`);
    // Browser timestamps can share a rounded millisecond. Do not turn one
    // duplicate into a permanent sensor fault or fabricate a positive dt.
    if (time <= this.previous) return null;
    this.previous = time;
    return { time, receivedTime, clock };
  }
}
