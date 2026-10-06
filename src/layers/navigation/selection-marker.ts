import { Marker, type Map as MapLibreMap } from 'maplibre-gl';
import type { GeoPointFeature } from '@zlayer/contracts';
import { featureIdent } from '@zlayer/domain';
import { formatWaypointLabel } from '../../core/format/coordinates';
import type { MapLayerModule } from '../../core/map/layer';
import { mapLabelKey, SELECTION_LABEL_ID_STATE } from '../../core/map/label';
import './selection-marker.css';

/** Panel focus stays outside symbol placement so it cannot hide map labels. */
export function createSelectionMarkerLayer(): MapLayerModule<GeoPointFeature | undefined> {
  let map: MapLibreMap | undefined;
  let feature: GeoPointFeature | undefined;
  let marker: Marker | undefined;
  let label: HTMLSpanElement | undefined;
  let labelKey = '';
  const render = () => {
    if (!map || !marker || !label) return;
    const key = feature ? mapLabelKey(feature) : '';
    if (feature) {
      const ident = featureIdent(feature);
      label.textContent = formatWaypointLabel(ident);
      label.title = label.textContent === ident ? '' : ident;
      marker.setLngLat(feature.geometry.coordinates).addTo(map);
    } else marker.remove();
    if (key !== labelKey) {
      map.setGlobalStateProperty(SELECTION_LABEL_ID_STATE, key);
      labelKey = key;
    }
  };
  return {
    id: 'navigation-selection', slot: 'annotation',
    mount(target) {
      map = target;
      const element = document.createElement('div');
      element.className = 'selection-marker';
      element.setAttribute('aria-hidden', 'true');
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 44 44');
      for (const className of ['selection-marker-halo', 'selection-marker-crosshair']) {
        const path = document.createElementNS(svg.namespaceURI, 'path');
        path.setAttribute('class', className);
        path.setAttribute('d', 'M22 2V10M22 34V42M2 22H10M34 22H42');
        svg.append(path);
      }
      label = document.createElement('span');
      label.className = 'selection-marker-label';
      // The selected name replaces a selectable map label. Clicking it must not
      // fall through to empty map space and clear the very selection it labels.
      label.addEventListener('click', event => event.stopPropagation());
      element.append(svg, label);
      marker = new Marker({ element, subpixelPositioning: true });
      render();
    },
    update(next) {
      if (feature === next) return;
      feature = next;
      render();
    },
    unmount() {
      marker?.remove(); marker = undefined; label = undefined;
      if (labelKey) map?.setGlobalStateProperty(SELECTION_LABEL_ID_STATE, '');
      labelKey = ''; map = undefined;
    },
  };
}
