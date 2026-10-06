import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';

const paths = ['/api/weather/healthz', '/api/notams/airports?faaId=SJC&icaoId=KSJC', '/api/notams/regions?artccId=ZOA'];
/** Bounded local-read sampling: never requests uncached reports or FAA work. */
export async function profileInfoServer(origin: string, options: { seconds: number; concurrency: number }) {
  const url = new URL(origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Supply a bare HTTP(S) origin');
  if (!Number.isInteger(options.seconds) || options.seconds < 1 || options.seconds > 3600 ||
    !Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 8) throw new Error('Use 1–3600 seconds and 1–8 readers');
  const started = performance.now(), deadline = started + options.seconds * 1000;
  const samples: number[] = [], statuses: Record<string, number> = {};
  let before: unknown, after: unknown, errors = 0, bytes = 0;
  const health = async () => (await fetch(url.origin + paths[0], { signal: AbortSignal.timeout(15000) })).json() as Promise<unknown>;
  before = await health();
  await Promise.all(Array.from({ length: options.concurrency }, async (_, worker) => {
    let count = worker;
    while (performance.now() < deadline) {
      const at = performance.now();
      try {
        const response = await fetch(url.origin + paths[count++ % paths.length], { signal: AbortSignal.timeout(15000) });
        statuses[response.status] = (statuses[response.status] ?? 0) + 1;
        bytes += (await response.arrayBuffer()).byteLength;
      } catch { errors++; }
      samples.push(performance.now() - at);
      await delay(100); // <= 288,000 timings at maximum duration/concurrency.
    }
  }));
  after = await health(); samples.sort((a, b) => a - b);
  const percentile = (p: number) => samples[Math.max(0, Math.ceil(samples.length * p) - 1)] ?? null;
  return { origin: url.origin, startedAt: new Date(Date.now() - (performance.now() - started)).toISOString(),
    seconds: (performance.now() - started) / 1000, concurrency: options.concurrency, requests: samples.length,
    statuses, errors, bytes, latencyMs: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), max: samples.at(-1) }, before, after };
}
if (import.meta.main) {
  const [origin, output, seconds = '60', concurrency = '2'] = process.argv.slice(2);
  if (!origin || !output) throw new Error('Usage: node --import tsx tools/profile-info-server.ts ORIGIN OUTPUT.json [SECONDS=60] [READERS=2]');
  await writeFile(output, JSON.stringify(await profileInfoServer(origin, { seconds: Number(seconds), concurrency: Number(concurrency) }), null, 2) + '\n');
}
