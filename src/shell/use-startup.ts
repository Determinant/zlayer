import { useCallback, useEffect, useRef, useState } from 'react';
import { startupStepBlocking, type StartupStep } from '../workspace/startup';

const MINIMUM_MS = 900;
const QUIET_MS = 300;
const BUSY_FRAME_MS = 50;
const MAX_SETTLE_MS = 1500;
const SLOW_MS = 15_000;

/** Release once per launch, after initial work and a short responsive frame run. */
export function useStartup(steps: readonly StartupStep[], failed: boolean) {
  const started = useRef(performance.now());
  const [settled, setSettled] = useState<readonly StartupStep[]>();
  const [complete, setComplete] = useState(false);
  const [slow, setSlow] = useState(false);
  const finish = useCallback(() => setComplete(true), []);
  useEffect(() => {
    // Once initial data and its map render are ready, later background updates
    // must not restart startup or move its completed progress backward.
    if (!complete && !settled && !steps.some(startupStepBlocking)) setSettled(steps);
  }, [complete, settled, steps]);
  useEffect(() => {
    if (complete) return;
    const timer = setTimeout(() => setSlow(true), Math.max(0, SLOW_MS - (performance.now() - started.current)));
    return () => clearTimeout(timer);
  }, [complete]);
  useEffect(() => {
    if (complete) return;
    if (failed) { finish(); return; }
    if (!settled) return;
    let previous = performance.now(), quietSince = previous, frame = 0;
    // Loaded work must remain usable on slow or throttled displays. This deadline
    // starts only after required data and the initial map render have settled.
    const deadline = setTimeout(finish, Math.max(MAX_SETTLE_MS, MINIMUM_MS - (previous - started.current)));
    const settle = (now: number) => {
      if (now - previous > BUSY_FRAME_MS) quietSince = now;
      previous = now;
      if (now - started.current >= MINIMUM_MS && now - quietSince >= QUIET_MS) finish();
      else frame = requestAnimationFrame(settle);
    };
    frame = requestAnimationFrame(settle);
    return () => { cancelAnimationFrame(frame); clearTimeout(deadline); };
  }, [complete, settled, failed, finish]);
  // Required rows describe the completed initial load. Background rows continue
  // showing their live progress during the responsive-frame check.
  const initial = new Map(settled?.map(step => [step.id, step]));
  const progress = settled ? [
    ...settled.map(step => step.blocking === false ? steps.find(current => current.id === step.id) ?? step : step),
    ...steps.filter(step => step.blocking === false && !initial.has(step.id)),
  ] : steps;
  return { complete, slow, finish, steps: progress };
}
