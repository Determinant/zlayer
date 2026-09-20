/** Keep the application and top-layer dialogs in the same visible rectangle.
 * Mobile keyboards can resize/pan this rectangle without changing CSS viewport
 * units. Ignore pinch zoom: reflowing to its smaller rectangle defeats magnification.
 */
export function observeVisibleViewport(): () => void {
  const viewport = window.visualViewport;
  const style = document.documentElement.style;
  let frame = 0;
  const update = () => {
    frame = 0;
    if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
    // Let CSS follow ordinary window resizing immediately; override only when
    // the visual viewport differs (for example, when a keyboard covers content).
    for (const [name, visible, layout] of [
      ['width', viewport?.width, window.innerWidth],
      ['height', viewport?.height, window.innerHeight],
    ] as const) {
      if (visible !== undefined && Math.abs(visible - layout) > 1) style.setProperty(`--viewport-${name}`, `${visible}px`);
      else style.removeProperty(`--viewport-${name}`);
    }
    style.setProperty('--viewport-left', `${viewport?.offsetLeft ?? 0}px`);
    style.setProperty('--viewport-top', `${viewport?.offsetTop ?? 0}px`);
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
  update();
  window.addEventListener('resize', schedule);
  viewport?.addEventListener('resize', schedule);
  viewport?.addEventListener('scroll', schedule);
  return () => {
    cancelAnimationFrame(frame);
    window.removeEventListener('resize', schedule);
    viewport?.removeEventListener('resize', schedule);
    viewport?.removeEventListener('scroll', schedule);
    for (const name of ['width', 'height', 'left', 'top']) style.removeProperty(`--viewport-${name}`);
  };
}
