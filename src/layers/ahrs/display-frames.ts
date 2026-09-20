type FrameClock = {
  request(callback: (milliseconds: number) => void): number;
  cancel(frame: number): void;
};

/** Render at most 60 frames/second, regardless of the display refresh rate.
 * Keep the cadence across fractional timestamps and skip missed frames. */
export function startDisplayFrames(draw: (milliseconds: number) => void, clock: FrameClock = {
  request: callback => requestAnimationFrame(callback), cancel: frame => cancelAnimationFrame(frame),
}): () => void {
  const interval = 1000 / 60;
  let last: number | undefined, stopped = false;
  const tick = (milliseconds: number) => {
    if (stopped) return;
    const elapsed = last === undefined ? Infinity : milliseconds - last;
    if (elapsed >= interval - .01) {
      last = last === undefined ? milliseconds : last + Math.floor((elapsed + .01) / interval) * interval;
      draw(milliseconds);
    }
    if (!stopped) frame = clock.request(tick);
  };
  let frame = clock.request(tick);
  return () => { stopped = true; clock.cancel(frame); };
}
