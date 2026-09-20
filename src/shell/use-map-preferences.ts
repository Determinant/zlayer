import { useEffect, useState } from 'react';
import { isRecord } from '@zlayer/contracts';
import { CHART_BASES, CHART_OVERLAYS, type ChartBaseSelection, type ChartOverlaySelection } from '../layers/charts/overlays';
import { DEFAULT_VISIBILITY, NAVIGATION_LAYERS, type LayerVisibility } from '../layers/navigation/definitions';
import { DEFAULT_FIX_DISPLAY, type FixDisplaySettings } from '../layers/navigation/fix-display';
import { MAX_TERRAIN_ALTITUDE, TERRAIN_ALTITUDE_STEP } from '../layers/terrain/clearance';

type MapPreferences = {
  chartBase: ChartBaseSelection | undefined;
  chartOverlay: ChartOverlaySelection;
  visibility: LayerVisibility;
  fixDisplay: FixDisplaySettings;
  metarEnabled: boolean;
  terrainEnabled: boolean;
  obstructionsEnabled: boolean;
  terrainAltitude: number | null;
  ownshipEnabled: boolean;
};

const STORAGE_KEY = 'zlayers-map-preferences-v1';

export function useMapPreferences() {
  const [preferences, setPreferences] = useState(readPreferences);
  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, ...preferences }));
    } catch {
      // Denied/full storage must not prevent changing settings for this session.
    }
  }, [preferences]);
  return [preferences, setPreferences] as const;
}

function readPreferences(): MapPreferences {
  let saved: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (isRecord(value)) saved = value;
  } catch {
    // Missing, corrupt, or inaccessible storage uses normal startup defaults.
  }
  const visibility = { ...DEFAULT_VISIBILITY };
  if (isRecord(saved.visibility)) {
    for (const { id } of NAVIGATION_LAYERS) {
      if (typeof saved.visibility[id] === 'boolean') visibility[id] = saved.visibility[id];
    }
  }
  const fix = isRecord(saved.fixDisplay) ? saved.fixDisplay : {};
  // Migrate the original single-family preference in place, preserving switches.
  const legacyBase = saved.chartOverlay === '' ? ''
    : CHART_BASES.find(base => base.id === saved.chartOverlay)?.id
      ?? CHART_OVERLAYS.find(overlay => overlay.id === saved.chartOverlay)?.requires;
  const base = saved.chartBase === undefined && saved.version !== 2 ? legacyBase : saved.chartBase;
  return {
    // An explicit base-map-only choice ('') must not become automatic selection.
    chartBase: base === '' ? '' : CHART_BASES.find(item => item.id === base)?.id,
    chartOverlay: CHART_OVERLAYS.find(item => item.id === saved.chartOverlay)?.id ?? '',
    visibility,
    fixDisplay: {
      detail: choice(fix.detail, ['enroute', 'terminal', 'all'], DEFAULT_FIX_DISPLAY.detail),
      airspace: choice(fix.airspace, ['low', 'high', 'both'], DEFAULT_FIX_DISPLAY.airspace),
    },
    metarEnabled: typeof saved.metarEnabled === 'boolean' ? saved.metarEnabled : true,
    ownshipEnabled: typeof saved.ownshipEnabled === 'boolean' ? saved.ownshipEnabled : true,
    terrainEnabled: typeof saved.terrainEnabled === 'boolean' ? saved.terrainEnabled : true,
    obstructionsEnabled: typeof saved.obstructionsEnabled === 'boolean' ? saved.obstructionsEnabled : true,
    terrainAltitude: typeof saved.terrainAltitude === 'number' && Number.isFinite(saved.terrainAltitude)
      && saved.terrainAltitude >= 0 && saved.terrainAltitude <= MAX_TERRAIN_ALTITUDE
      ? Math.round(saved.terrainAltitude / TERRAIN_ALTITUDE_STEP) * TERRAIN_ALTITUDE_STEP : null,
  };
}

function choice<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return options.find(option => option === value) ?? fallback;
}
