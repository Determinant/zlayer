/** Coalesce event-driven drawing into one frame. The callback reads current
 * inputs; flush preserves actions that must take effect immediately. No idle loop. */
export function createFrameTask(draw: () => void) {
  let frame: number | undefined;
  const cancel = () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
  };
  return {
    schedule() {
      frame ??= requestAnimationFrame(() => {
        frame = undefined;
        draw();
      });
    },
    cancel,
    flush() { cancel(); draw(); },
  };
}
