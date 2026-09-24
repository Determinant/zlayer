/** Bounded local diagnostics, visible in DevTools' User Timing track. No telemetry. */
type Sample = { stage: string; ms: number };
const samples: Sample[] = [];
export const weatherPerformance = (): readonly Sample[] => samples.slice();
export function weatherTiming(stage: string): () => void {
  const start = performance.now(); let finished = false;
  return () => {
    if (finished) return; finished = true;
    const end = performance.now(), name = `zlayer.weather.${stage}`;
    samples.push({ stage, ms: end - start }); if (samples.length > 64) samples.shift();
    performance.clearMeasures(name); performance.measure(name, { start, end });
  };
}
