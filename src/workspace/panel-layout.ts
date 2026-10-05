import { validatePanelLayout, type PanelLayout } from '../core/layers/panel-layout';

/** Product layout policy. Missing panels leave their reserved positions intact. */
export const PANEL_LAYOUT = {
  charts: { side: 'left', tab: { edge: 'top', order: 0 } },
  gps: { side: 'left', tab: { edge: 'top', order: 1 } },
  ahrs: { side: 'left', tab: { edge: 'top', order: 2 }, bodyFromEdge: true },
  terrain: { side: 'left', tab: { edge: 'bottom', order: 0 } },
  'weather-awc': { side: 'left', tab: { edge: 'bottom', order: 1 }, bodyFromEdge: true },
  glide: { side: 'left', tab: { edge: 'bottom', order: 2 }, bodyFromEdge: true },
  plate: { side: 'right', tab: { edge: 'bottom', order: 0 } },
  details: { side: 'right', tab: { edge: 'bottom', order: 1 } },
  'weather-awc-details': { side: 'right', tab: { edge: 'bottom', order: 2 } },
  'notams-tfr-details': { side: 'right', tab: false },
} as const satisfies PanelLayout;

validatePanelLayout(PANEL_LAYOUT);
