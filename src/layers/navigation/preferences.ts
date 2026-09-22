import { pluginStorage } from './storage';
import { isRecord } from '@zlayer/contracts';
import { DEFAULT_VISIBILITY, NAVIGATION_LAYERS, type LayerVisibility } from './definitions';
import { DEFAULT_FIX_DISPLAY, type FixDisplaySettings } from './fix-display';
import { choice, pluginPreferences } from '../../core/storage/preferences';
export const navigationPreferences = pluginPreferences<{ visibility: LayerVisibility; fixDisplay: FixDisplaySettings }>(pluginStorage, saved => {
  const visibility = { ...DEFAULT_VISIBILITY };
  if (isRecord(saved.visibility)) for (const { id } of NAVIGATION_LAYERS) {
    if (typeof saved.visibility[id] === 'boolean') visibility[id] = saved.visibility[id];
  }
  const fix = isRecord(saved.fixDisplay) ? saved.fixDisplay : {};
  return { visibility, fixDisplay: {
    detail: choice(fix.detail, ['enroute', 'terminal', 'all'], DEFAULT_FIX_DISPLAY.detail),
    airspace: choice(fix.airspace, ['low', 'high', 'both'], DEFAULT_FIX_DISPLAY.airspace),
  } };
}, 'zlayers-map-preferences-v1');
