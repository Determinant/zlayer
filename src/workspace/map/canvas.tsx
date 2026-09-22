import { useEffect, useRef } from 'react';
import type { GeoPointFeature } from '@zlayer/contracts';
import type { MapCallbacks, MapAttachment } from './inputs';
import type { MapView } from './style';
import { MapRuntime } from './runtime';

type MapCanvasProps = MapCallbacks & MapAttachment & {
  initialView?: MapView; focusTarget: { feature: GeoPointFeature; nonce: number } | undefined;
};
export function MapCanvas({ contributions, orientation, initialView, focusTarget, ...handlers }: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<MapRuntime | undefined>(undefined);
  const callbacks = useRef(handlers);
  callbacks.current = handlers;
  useEffect(() => {
    if (!containerRef.current) return;
    try {
      const runtime = new MapRuntime({
        container: containerRef.current, contributions, orientation, ...(initialView ? { initialView } : {}),
        onViewportChange: bounds => callbacks.current.onViewportChange(bounds),
        onViewChange: view => callbacks.current.onViewChange?.(view),
        onReady: () => callbacks.current.onReady(),
        onIdleChange: idle => callbacks.current.onIdleChange?.(idle),
        onError: (message, code) => callbacks.current.onError(message, code),
      });
      runtimeRef.current = runtime;
      return () => { runtime.destroy(); runtimeRef.current = undefined; };
    } catch (error) {
      callbacks.current.onStartupFailure?.();
      callbacks.current.onError(error instanceof Error ? error.message : 'Unable to create WebGL map.');
      return undefined;
    }
  }, [orientation]);
  useEffect(() => { runtimeRef.current?.setContributions(contributions); }, [contributions]);
  useEffect(() => { if (focusTarget) runtimeRef.current?.focus(focusTarget.feature); }, [focusTarget]);
  return <div className="map-canvas" ref={containerRef} aria-label="Aviation chart map" />;
}
export default MapCanvas;
