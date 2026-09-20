import { createMetarLayer } from '../layers/metar-taf';
import { createPlatesLayer } from '../layers/plates';
import { createOwnshipLayer } from '../layers/ownship';
import { createAhrsLayer } from '../layers/ahrs';

/** Workspace product instances outlive their map, panel, or detail presentations. */
export function createWorkspaceLayers() {
  const metar = createMetarLayer();
  const plates = createPlatesLayer();
  const ownship = createOwnshipLayer();
  const ahrs = createAhrsLayer(ownship);
  return { metar, plates, ownship, ahrs, panels: [plates] };
}
