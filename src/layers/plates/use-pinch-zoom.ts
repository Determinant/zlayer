import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

export const clampPlateZoom = (zoom: number) => Math.max(0.5, Math.min(4, zoom));

/** Own gestures inside the PDF, preserving native one-finger scrolling elsewhere. */
export function usePinchZoom(stageRef: RefObject<HTMLDivElement | null>, canvasRef: RefObject<HTMLCanvasElement | null>,
  zoom: number, onZoom: (zoom: number) => void, enabled: boolean): boolean {
  const [pinching, setPinching] = useState(false);
  const currentZoom = useRef(zoom);
  useLayoutEffect(() => { currentZoom.current = zoom; }, [zoom]);

  useEffect(() => {
    setPinching(false);
    const stage = stageRef.current, canvas = canvasRef.current;
    if (!enabled || !stage || !canvas) return;
    let touchMode = false;
    let pan: { id: number; x: number; y: number } | undefined;
    let pinch: { zoom: number; width: number; height: number; x: number; y: number;
      distance: number; ids: number[] | undefined } | undefined;
    const prevent = (event: Event) => { if (event.cancelable) event.preventDefault(); };
    const start = (x: number, y: number, distance: number, ids?: number[]) => {
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      pinch = { zoom: currentZoom.current, width: rect.width, height: rect.height,
        x: (x - rect.left) / rect.width, y: (y - rect.top) / rect.height, distance: Math.max(1, distance), ids };
      pan = undefined;
      setPinching(true);
    };
    const move = (x: number, y: number, distance: number) => {
      if (!pinch) return;
      const next = clampPlateZoom(pinch.zoom * distance / pinch.distance);
      // Preview the existing bitmap immediately; PDF.js redraws once fingers lift.
      canvas.style.width = `${pinch.width * next / pinch.zoom}px`;
      canvas.style.height = `${pinch.height * next / pinch.zoom}px`;
      const rect = canvas.getBoundingClientRect();
      // WebKit truncates fractional scroll offsets. Choose the nearest pixel so
      // the page stays centered under the fingers instead of drifting one way.
      stage.scrollLeft = Math.round(stage.scrollLeft + rect.left + pinch.x * rect.width - x);
      stage.scrollTop = Math.round(stage.scrollTop + rect.top + pinch.y * rect.height - y);
      currentZoom.current = next;
      onZoom(next);
    };
    const finish = () => { pinch = undefined; pan = undefined; touchMode = false; setPinching(false); };
    const touches = (event: TouchEvent) => Array.from(event.touches)
      .filter(touch => touch.target instanceof Node && stage.contains(touch.target));
    const pair = (a: Touch, b: Touch) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2,
      distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) });
    const beginTouches = (points: Touch[]) => {
      touchMode = true;
      if (points.length !== 2) { pinch = undefined; return; }
      const [a, b] = points as [Touch, Touch], point = pair(a, b);
      start(point.x, point.y, point.distance, [a.identifier, b.identifier]);
    };
    const onStart = (event: TouchEvent) => {
      const points = touches(event);
      if (points.length < 2) return;
      prevent(event);
      beginTouches(points);
    };
    const onMove = (event: TouchEvent) => {
      const points = touches(event);
      if (points.length >= 2) {
        prevent(event);
        const ids = pinch?.ids;
        if (points.length !== 2 || !ids || points.some(point => !ids.includes(point.identifier))) {
          beginTouches(points);
          return;
        }
        const point = pair(points[0]!, points[1]!);
        move(point.x, point.y, point.distance);
      } else if (touchMode && points.length === 1) {
        // A remaining finger can keep panning after the pinch consumed its start.
        prevent(event);
        const point = points[0]!;
        if (pan?.id === point.identifier) {
          stage.scrollLeft += pan.x - point.clientX;
          stage.scrollTop += pan.y - point.clientY;
        }
        pan = { id: point.identifier, x: point.clientX, y: point.clientY };
      }
    };
    const onEnd = (event: TouchEvent) => {
      if (!touchMode) return;
      prevent(event);
      const points = touches(event);
      if (points.length >= 2) { beginTouches(points); return; }
      pinch = undefined;
      setPinching(false);
      const point = points[0];
      if (point) pan = { id: point.identifier, x: point.clientX, y: point.clientY };
      else finish();
    };
    const onGesture = (event: Event) => {
      // Safari also emits GestureEvents. Suppress native page zoom, and use this
      // path for trackpads that provide gesture scale without TouchEvents.
      prevent(event);
      if (touchMode) return;
      const gesture = event as Event & { scale: number; clientX?: number; clientY?: number };
      const rect = stage.getBoundingClientRect();
      const x = gesture.clientX ?? rect.left + rect.width / 2;
      const y = gesture.clientY ?? rect.top + rect.height / 2;
      if (event.type === 'gestureend') finish();
      else if (Number.isFinite(gesture.scale) && gesture.scale > 0) {
        if (event.type === 'gesturestart') start(x, y, gesture.scale);
        else move(x, y, gesture.scale);
      }
    };
    stage.addEventListener('touchstart', onStart, { passive: false });
    stage.addEventListener('touchmove', onMove, { passive: false });
    stage.addEventListener('touchend', onEnd, { passive: false });
    stage.addEventListener('touchcancel', finish);
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) stage.addEventListener(type, onGesture, { passive: false });
    window.addEventListener('resize', finish);
    return () => {
      stage.removeEventListener('touchstart', onStart);
      stage.removeEventListener('touchmove', onMove);
      stage.removeEventListener('touchend', onEnd);
      stage.removeEventListener('touchcancel', finish);
      for (const type of ['gesturestart', 'gesturechange', 'gestureend']) stage.removeEventListener(type, onGesture);
      window.removeEventListener('resize', finish);
    };
  }, [stageRef, canvasRef, enabled, onZoom]);
  return pinching;
}
