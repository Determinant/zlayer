import { NavigationControl, type Map as MapLibreMap } from 'maplibre-gl';
import { isBoolean, readUiState, writeUiState } from '../../core/storage/ui-state';
import type { OwnshipLayer } from '../../layers/ownship';

/** Zoom and an aviation orientation toggle sharing the existing GPS watch. */
export class MapNavigationControl extends NavigationControl {
  readonly #ownship: OwnshipLayer;
  readonly #toggle = document.createElement('button');
  readonly #mode = document.createElement('span');
  #map: MapLibreMap | undefined;
  #unsubscribe: (() => void) | undefined;
  #trackUp = readUiState('map-track-up', false, isBoolean);

  constructor(ownship: OwnshipLayer) {
    super({ showCompass: false });
    this.#ownship = ownship;
    this.#toggle.type = 'button';
    this.#toggle.className = 'map-orientation-toggle';
    this.#toggle.setAttribute('aria-label', 'Track up');
    this.#mode.className = 'map-orientation-mode';
    const up = document.createElement('span');
    up.className = 'map-orientation-up';
    up.textContent = 'UP';
    this.#toggle.append(this.#mode, up);
    this.#toggle.addEventListener('click', () => {
      this.#trackUp = !this.#trackUp;
      writeUiState('map-track-up', this.#trackUp);
      this.#update();
    });
  }

  override onAdd(map: MapLibreMap): HTMLElement {
    const container = super.onAdd(map);
    container.classList.add('map-navigation-control');
    container.setAttribute('role', 'group');
    container.setAttribute('aria-label', 'Map navigation');
    container.append(this.#toggle);
    this.#map = map;
    this.#unsubscribe = this.#ownship.subscribe(this.#update);
    map.on('moveend', this.#update);
    this.#update();
    return container;
  }

  override onRemove(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#map?.off('moveend', this.#update);
    this.#map = undefined;
    super.onRemove();
  }

  /** Fit cameras at the intended orientation, including during a rotation. */
  getTargetBearing(): number {
    return this.#desiredBearing ?? this.#map?.getBearing() ?? 0;
  }

  get #desiredBearing(): number | null {
    if (!this.#trackUp) return 0;
    const snapshot = this.#ownship.getSnapshot();
    return snapshot.enabled && snapshot.state === 'tracking' ? snapshot.fix?.track ?? null : null;
  }

  readonly #update = (): void => {
    const map = this.#map;
    if (!map) return;
    const bearing = this.#desiredBearing;
    const waiting = bearing === null;
    const description = this.#trackUp
      ? `Track up${waiting ? ' · Waiting for GPS track' : ''} · Switch to north up`
      : 'North up · Switch to track up';
    this.#mode.textContent = this.#trackUp ? 'TRK' : 'N';
    this.#toggle.setAttribute('aria-pressed', String(this.#trackUp));
    this.#toggle.setAttribute('aria-description', description);
    this.#toggle.title = description;
    this.#toggle.classList.toggle('is-waiting', waiting);

    // Hold the last orientation when track is unavailable. Apply new tracks
    // after camera movement so GPS cannot interrupt a pan, zoom, or route fit.
    if (bearing === null || map.isMoving()) return;
    const difference = ((bearing - map.getBearing() + 540) % 360) - 180;
    if (Math.abs(difference) > 0.01) map.rotateTo(bearing, { duration: 250 });
  };
}
