import { useCallback, useEffect, useRef, useState } from 'react';

const MINIMUM_MS = 900;
const QUIET_MS = 300;
const BUSY_FRAME_MS = 50;
const SLOW_MS = 15_000;

/** Release once per launch, after initial work and a short responsive frame run. */
export function useStartup(ready: boolean, failed: boolean) {
  const started = useRef(performance.now());
  const [complete, setComplete] = useState(false);
  const [slow, setSlow] = useState(false);
  const finish = useCallback(() => setComplete(true), []);
  useEffect(() => {
    if (complete) return;
    const timer = setTimeout(() => setSlow(true), Math.max(0, SLOW_MS - (performance.now() - started.current)));
    return () => clearTimeout(timer);
  }, [complete]);
  useEffect(() => {
    if (complete) return;
    if (failed) { finish(); return; }
    if (!ready) return;
    let previous = performance.now(), quietSince = previous, frame = 0;
    const settle = (now: number) => {
      if (now - previous > BUSY_FRAME_MS) quietSince = now;
      previous = now;
      if (now - started.current >= MINIMUM_MS && now - quietSince >= QUIET_MS) finish();
      else frame = requestAnimationFrame(settle);
    };
    frame = requestAnimationFrame(settle);
    return () => cancelAnimationFrame(frame);
  }, [complete, ready, failed, finish]);
  return { complete, slow, finish };
}
