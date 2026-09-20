import { useEffect, useRef } from 'react';
import type { GeoPointFeature } from '@zlayer/contracts';
import type { MapInputs, MapCallbacks, MapAttachment } from './inputs';
import type { MapView } from './style';
import { MapRuntime } from './runtime';
import type { NearbyFeature } from '../feature-selection';

type FocusTarget = { feature: GeoPointFeature; nonce: number };

type MapCanvasProps = MapInputs & MapCallbacks & MapAttachment & {
  initialView?: MapView;
  routeFocusNonce: number;
  focusTarget: FocusTarget | undefined;
};

export function MapCanvas({
  catalog,
  chartSelection,
  visibility,
  fixContext,
  data,
  route,
  recommendations,
  identification,
  initialView,
  routeFocusNonce,
  focusTarget,
  onSelect,
  onChooseNearby,
  onViewportChange,
  onViewChange,
  onRouteLegInsert,
  onRouteWaypointReplace,
  onRouteWaypointRemove,
  metarLayer,
  ownshipLayer,
  ownshipEnabled,
  metarEnabled,
  terrainEnabled,
  obstructionsEnabled,
  terrainAltitude,
  onTerrainStatus,
  onObstructionStatus,
  onReady,
  onError,
}: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<MapRuntime | undefined>(undefined);
  const callbacks = useRef<MapCallbacks>({ onSelect, onViewportChange, ...(onViewChange ? { onViewChange } : {}), onRouteLegInsert,
    onRouteWaypointReplace, onRouteWaypointRemove, onReady, onError, onTerrainStatus, onObstructionStatus });
  callbacks.current = { onSelect, ...(onChooseNearby ? { onChooseNearby } : {}), onViewportChange,
    ...(onViewChange ? { onViewChange } : {}), onRouteLegInsert,
    onRouteWaypointReplace, onRouteWaypointRemove, onReady, onError, onTerrainStatus, onObstructionStatus };

  useEffect(() => {
    if (!containerRef.current) return;
    try {
      const runtime = new MapRuntime({
        container: containerRef.current,
        catalog,
        chartSelection,
        visibility,
        fixContext,
        data,
        route,
        recommendations,
        identification,
        ...(initialView ? { initialView } : {}),
        onSelect: (feature, routePointId) => callbacks.current.onSelect(feature, routePointId),
        ...(callbacks.current.onChooseNearby ? { onChooseNearby: (features: NearbyFeature[], point: { x: number; y: number }) => callbacks.current.onChooseNearby?.(features, point) } : {}),
        onViewportChange: (bounds) => callbacks.current.onViewportChange(bounds),
        onViewChange: (view) => callbacks.current.onViewChange?.(view),
        onRouteLegInsert: (afterEntryId, feature) =>
          callbacks.current.onRouteLegInsert(afterEntryId, feature),
        onRouteWaypointReplace: (entryId, feature) =>
          callbacks.current.onRouteWaypointReplace(entryId, feature),
        onRouteWaypointRemove: (entryId) =>
          callbacks.current.onRouteWaypointRemove(entryId),
        metarLayer,
        ownshipLayer,
        ownshipEnabled,
        metarEnabled,
        terrainEnabled,
        obstructionsEnabled,
        terrainAltitude,
        onTerrainStatus: status => callbacks.current.onTerrainStatus(status),
        onObstructionStatus: status => callbacks.current.onObstructionStatus(status),
        onReady: () => callbacks.current.onReady(),
        onError: (message, code) => callbacks.current.onError(message, code),
      });
      runtimeRef.current = runtime;
      return () => {
        runtime.destroy();
        runtimeRef.current = undefined;
      };
    } catch (error) {
      callbacks.current.onError(error instanceof Error ? error.message : 'Unable to create WebGL map.');
      return undefined;
    }
  // Catalog/data changes are inputs to this runtime, not a new map attachment.
  }, [metarLayer, ownshipLayer]);

  useEffect(() => runtimeRef.current?.update({ catalog, chartSelection, visibility, fixContext,
    metarEnabled, terrainEnabled, obstructionsEnabled, terrainAltitude, ownshipEnabled, data, route, recommendations, identification }),
  [catalog, chartSelection, visibility, fixContext, metarEnabled, terrainEnabled, obstructionsEnabled, terrainAltitude, ownshipEnabled, data, route, recommendations, identification]);
  useEffect(() => {
    if (focusTarget) runtimeRef.current?.focus(focusTarget.feature);
  }, [focusTarget]);
  useEffect(() => {
    if (routeFocusNonce > 0) runtimeRef.current?.fitRoute();
  }, [routeFocusNonce]);

  return <div className="map-canvas" ref={containerRef} aria-label="Aviation chart map" />;
}

export default MapCanvas;
