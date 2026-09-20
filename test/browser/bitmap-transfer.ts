// A small reproducer without MapLibre. The optional accelerated control retains
// the failing path for upstream diagnosis and like-for-like performance checks.
export async function bitmapTransfers(accelerated = false, count = 256) {
  const producer = new Worker(new URL('./bitmap-transfer.worker.ts', import.meta.url), { type: 'module' });
  const consumer = new Worker(new URL('./bitmap-transfer.worker.ts', import.meta.url), { type: 'module' });
  const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
  const failures: { id: number; samples: number[][] }[] = [];
  const times: number[] = [], started = new Map<number, number>();
  const crash = (event: ErrorEvent) => {
    for (const request of pending.values()) request.reject(new Error(event.message));
  };
  producer.onerror = consumer.onerror = crash;
  producer.onmessage = ({ data }) => consumer.postMessage(data, [data.image]);
  consumer.onmessage = ({ data: { id, samples } }: MessageEvent<{ id: number; samples: number[][] }>) => {
    if (samples.some((pixel, quadrant) => pixel[0] !== id % 256 || pixel[1] !== quadrant * 64 ||
      pixel[2] !== 255 - id % 256 || pixel[3] !== 255)) failures.push({ id, samples });
    times.push(performance.now() - started.get(id)!);
    pending.get(id)!.resolve(); pending.delete(id);
  };
  const begin = performance.now();
  try {
    for (let batch = 0; batch < count; batch += 4) {
      await Promise.all(Array.from({ length: Math.min(4, count - batch) }, (_, index) => new Promise<void>((resolve, reject) => {
        const id = batch + index;
        started.set(id, performance.now()); pending.set(id, { resolve, reject });
        producer.postMessage({ id, accelerated });
      })));
    }
    times.sort((a, b) => a - b);
    return { count, failures, elapsedMs: performance.now() - begin,
      medianMs: times[Math.floor(times.length / 2)]!, p95Ms: times[Math.floor(times.length * 0.95)]! };
  } finally { producer.terminate(); consumer.terminate(); }
}
