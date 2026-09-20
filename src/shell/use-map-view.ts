import { useMemo, useState } from 'react';
import { isRecord } from '@zlayer/contracts';
import type { MapView } from '../workspace/map/style';

const STORAGE_KEY = 'zlayers-map-view-v1';

export function useMapView() {
  const [restored] = useState(readMapView);
  const save = useMemo(() => (view: MapView) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, ...view }));
    } catch {
      // Denied/full storage must not prevent changing the map for this session.
    }
  }, []);
  // The map owns the live camera; persisting it must not re-render the workspace.
  return [restored, save] as const;
}

export function readMapView(): MapView | undefined {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.center) || value.center.length !== 2 ||
      !value.center.every(item => typeof item === 'number' && Number.isFinite(item)) ||
      typeof value.zoom !== 'number' || !Number.isFinite(value.zoom)) return undefined;
    const [longitude, latitude] = value.center;
    if (latitude < -90 || latitude > 90 || value.zoom < 3 || value.zoom > 13) {
      return undefined;
    }
    return { center: [longitude, latitude], zoom: value.zoom,
      bearing: typeof value.bearing === 'number' && Number.isFinite(value.bearing) ? value.bearing : 0,
      pitch: typeof value.pitch === 'number' && Number.isFinite(value.pitch) && value.pitch >= 0 && value.pitch <= 85 ? value.pitch : 0 };
  } catch {
    // Missing, corrupt, or inaccessible storage uses the normal startup view.
    return undefined;
  }
}
