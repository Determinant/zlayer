import type { Map as MapLibreMap } from 'maplibre-gl';

// Imported only by the benchmark build transform. No application API or telemetry.
type Timing = { count: number; failed: number; cancelled: number; totalMs: number; maxMs: number; samples: number[] };
const timing = (): Timing => ({ count: 0, failed: 0, cancelled: 0, totalMs: 0, maxMs: 0, samples: [] });
const add = (metric: Timing, elapsed: number) => {
  metric.count++; metric.totalMs += elapsed; metric.maxMs = Math.max(metric.maxMs, elapsed);
  if (metric.samples.length < 4096) metric.samples.push(elapsed);
};
const summary = ({ samples, ...rest }: Timing) => {
  const sorted = [...samples].sort((a, b) => a - b);
  const percentile = (p: number) => sorted.length ? sorted[Math.ceil(sorted.length * p) - 1]! : null;
  return { ...rest, sampled: sorted.length, p50Ms: percentile(.5), p95Ms: percentile(.95) };
};
let map: MapLibreMap | undefined;
let started = 0, phase = 'load', active = true;
let stages: Record<string, Timing> = {};
let frames = timing(), response = timing();
let previousRender: number | undefined, moveStarted: number | undefined;
let chartSettledMs: number | null = null;
let readyTiles = 0, emptyTiles = 0, boundaryTiles = 0;
let residentBytes = 0, residentPackages = 0, peakBytes = 0, peakPackages = 0;
let opening = 0, peakOpening = 0, reopens = 0;
const opened = new Set<string>();
let uploads: Record<string, number> = {};
let longTasks = timing();
const longTaskSupported = typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes.includes('longtask');
const observer = longTaskSupported ? new PerformanceObserver(list => {
  if (active) for (const entry of list.getEntries()) if (entry.startTime >= started) add(longTasks, entry.duration);
}) : undefined;
observer?.observe({ type: 'longtask', buffered: true });

// Guard against a disconnected probe: the driver requires real navigation uploads.
if (typeof window !== 'undefined') {
  const post = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function(message, options) {
    if (active && message?.type === 'LD' && message.data?.source?.startsWith('nav-')) {
      const id = message.data.source as string;
      uploads[id] = (uploads[id] ?? 0) + 1;
    }
    return post.call(this, message, options as StructuredSerializeOptions);
  };
}

export const renderingProbe = {
  attach(target: MapLibreMap) {
    map = target;
    map.on('movestart', () => { moveStarted = performance.now(); previousRender = undefined; });
    map.on('render', () => {
      if (!active) return;
      const now = performance.now();
      if (moveStarted !== undefined) { add(response, now - moveStarted); moveStarted = undefined; }
      if (map!.isMoving()) {
        if (previousRender !== undefined) add(frames, now - previousRender);
        previousRender = now;
      } else previousRender = undefined;
    });
    map.on('idle', () => {
      if (active && chartSettledMs === null && readyTiles > 0) chartSettledMs = performance.now() - started;
    });
  },
  get map() { if (!map) throw new Error('Benchmark map not attached'); return map; },
  get pendingOpens() { return opening; },
  begin(name: string) {
    phase = name; started = performance.now(); active = true;
    stages = {}; frames = timing(); response = timing(); longTasks = timing(); uploads = {};
    chartSettledMs = null; readyTiles = emptyTiles = boundaryTiles = reopens = 0;
    peakBytes = residentBytes; peakPackages = residentPackages; peakOpening = opening;
    previousRender = moveStarted = undefined;
    observer?.takeRecords();
  },
  snapshot() {
    for (const entry of observer?.takeRecords() ?? []) if (entry.startTime >= started) add(longTasks, entry.duration);
    active = false;
    return { phase, elapsedMs: performance.now() - started, chartSettledMs,
      stages: Object.fromEntries(Object.entries(stages).map(([key, value]) => [key, summary(value)])),
      movingFrameIntervals: summary(frames), moveToNextRender: summary(response),
      longTasks: longTaskSupported ? summary(longTasks) : null, navigationUploads: uploads,
      readyTiles, emptyTiles, boundaryTiles, packageReopens: reopens,
      packages: { residentBytes, peakBytes, residentPackages, peakPackages, peakOpening },
    };
  },
  measure<T>(name: string, args: unknown[], run: () => T): T {
    const measuredStages = stages;
    const metric = active ? stages[name] ??= timing() : undefined;
    const start = performance.now();
    if (name === 'package-open') {
      opening++; peakOpening = Math.max(peakOpening, opening);
      const url = String(args[0]);
      if (active && opened.has(url)) reopens++;
      opened.add(url);
    }
    if (active && name === 'regional' && (args[0] as unknown[]).length > 1) boundaryTiles++;
    const finish = (value: unknown, error?: unknown) => {
      if (name === 'package-open') opening--;
      if (metric) {
        add(metric, performance.now() - start);
        if (error) {
          if (error instanceof DOMException && error.name === 'AbortError') metric.cancelled++;
          else metric.failed++;
        } else if (name === 'tile' && active && stages === measuredStages) {
          if ((value as { data: unknown }).data) readyTiles++; else emptyTiles++;
        }
      }
      if (!error && name === 'package-resident') {
        const bytes = (args[0] as { data: ArrayBuffer }[]).reduce((sum, row) => sum + row.data.byteLength, 0);
        residentBytes += bytes; residentPackages++;
        peakBytes = Math.max(peakBytes, residentBytes); peakPackages = Math.max(peakPackages, residentPackages);
        const resource = value as { dispose(): void }, dispose = resource.dispose;
        let disposed = false;
        resource.dispose = () => {
          if (!disposed) { disposed = true; residentBytes -= bytes; residentPackages--; }
          dispose();
        };
      }
    };
    try {
      const result = run();
      if (result instanceof Promise) return result.then(value => { finish(value); return value; }, error => {
        finish(undefined, error); throw error;
      }) as T;
      finish(result); return result;
    } catch (error) { finish(undefined, error); throw error; }
  },
};

if (typeof window !== 'undefined') Object.assign(window, { renderingBenchmark: renderingProbe });
