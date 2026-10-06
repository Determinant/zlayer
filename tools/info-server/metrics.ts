import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

export type InfoOperation = 'notams.round' | 'notams.bulk' | 'notams.delta' | 'notams.parse' | 'notams.merge' |
  'notams.persist' | 'notams.index' | 'forecast.clouds' | 'forecast.icing' | 'forecast.winds';
export type DeliveryKind = 'weather' | 'notams' | 'health' | 'other';
const limits = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 120000, Infinity];

/** Fixed buckets bound memory independently of request count. Percentiles are
 * bucket upper bounds, not an unbounded list of individual timings. */
export class DurationStats {
  private buckets = limits.map(() => 0);
  private count = 0;
  private failed = 0;
  private active = 0;
  private totalMs = 0;
  private maxMs = 0;
  private lastMs: number | null = null;
  constructor(private readonly clock = () => performance.now()) {}
  start() {
    const started = this.clock(); this.active++;
    let finished = false;
    return (failed = false) => {
      if (finished) return;
      finished = true; this.active--; this.count++; if (failed) this.failed++;
      const ms = Math.max(0, this.clock() - started);
      this.lastMs = ms; this.totalMs += ms; this.maxMs = Math.max(this.maxMs, ms);
      this.buckets[limits.findIndex(limit => ms <= limit)]!++;
    };
  }
  get status() {
    const percentile = (fraction: number) => {
      if (!this.count) return null;
      let count = 0;
      for (const [index, amount] of this.buckets.entries()) {
        count += amount;
        if (count >= Math.ceil(this.count * fraction)) return Math.min(limits[index]!, this.maxMs);
      }
      return this.maxMs;
    };
    return { count: this.count, failed: this.failed, active: this.active, lastMs: this.lastMs, maxMs: this.maxMs,
      meanMs: this.count ? this.totalMs / this.count : null, p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99) };
  }
}

export class InfoMetrics {
  private readonly started = performance.now();
  private readonly delay = monitorEventLoopDelay({ resolution: 20 });
  private readonly operations = new Map<InfoOperation, DurationStats>();
  private readonly requests = new Map<DeliveryKind, DurationStats>();
  constructor() { this.delay.enable(); }
  private operation(name: InfoOperation) {
    let stats = this.operations.get(name);
    if (!stats) { stats = new DurationStats(); this.operations.set(name, stats); }
    return stats;
  }
  async measure<T>(name: InfoOperation, work: () => Promise<T>): Promise<T> {
    const finish = this.operation(name).start();
    try { const result = await work(); finish(); return result; }
    catch (cause) { finish(true); throw cause; }
  }
  measureSync<T>(name: InfoOperation, work: () => T): T {
    const finish = this.operation(name).start();
    try { const result = work(); finish(); return result; }
    catch (cause) { finish(true); throw cause; }
  }
  request(kind: DeliveryKind) {
    let stats = this.requests.get(kind);
    if (!stats) { stats = new DurationStats(); this.requests.set(kind, stats); }
    return stats.start();
  }
  get status() {
    const memory = process.memoryUsage();
    return { uptimeSeconds: (performance.now() - this.started) / 1000,
      memory: { rssBytes: memory.rss, peakRssBytes: process.resourceUsage().maxRSS * 1024,
        heapUsedBytes: memory.heapUsed, externalBytes: memory.external, arrayBufferBytes: memory.arrayBuffers },
      eventLoop: { samples: this.delay.count, p95Ms: this.delay.count ? this.delay.percentile(95) / 1e6 : null,
        p99Ms: this.delay.count ? this.delay.percentile(99) / 1e6 : null, maxMs: this.delay.count ? this.delay.max / 1e6 : null },
      requests: Object.fromEntries([...this.requests].map(([name, stats]) => [name, stats.status])),
      operations: Object.fromEntries([...this.operations].map(([name, stats]) => [name, stats.status])) };
  }
  close() { this.delay.disable(); }
}
