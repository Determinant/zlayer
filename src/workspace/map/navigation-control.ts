import { NavigationControl, type Map as MapLibreMap } from 'maplibre-gl';
import { isBoolean, readUiState, writeUiState } from '../../core/storage/ui-state';
import { createGpsCamera, type OrientationSource } from './gps-camera';
export type { OrientationSource } from './gps-camera';

/** Zoom and an aviation orientation toggle sharing the existing GPS watch. */
export class MapNavigationControl extends NavigationControl {
  readonly #ownship: OrientationSource;
  readonly #toggle = document.createElement('button');
  readonly #mode = document.createElement('span');
  #map: MapLibreMap | undefined;
  #description = '';
  #camera: ReturnType<typeof createGpsCamera> | undefined;
  #trackUp = readUiState('map-track-up', false, isBoolean);

  constructor(ownship: OrientationSource) {
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
      this.#camera?.setTrackUp(this.#trackUp);
    });
  }

  override onAdd(map: MapLibreMap): HTMLElement {
    const container = super.onAdd(map);
    container.classList.add('map-navigation-control');
    container.setAttribute('role', 'group');
    container.setAttribute('aria-label', 'Map navigation');
    container.append(this.#toggle);
    this.#map = map;
    this.#camera = createGpsCamera(map, this.#ownship, this.#trackUp, this.#update);
    this.#update();
    return container;
  }

  override onRemove(): void {
    this.#camera?.dispose();
    this.#camera = undefined;
    this.#map = undefined;
    super.onRemove();
  }

  /** Fit cameras at the intended orientation, including during a rotation. */
  getTargetBearing(): number {
    return this.#camera?.getTargetBearing() ?? this.#map?.getBearing() ?? 0;
  }

  readonly #update = (): void => {
    const map = this.#map;
    if (!map) return;
    const waiting = this.#camera?.waiting() ?? this.#trackUp;
    const description = this.#trackUp
      ? `Track up${waiting ? ' · Waiting for GPS track' : ''} · Switch to north up`
      : 'North up · Switch to track up';
    if (description === this.#description) return;
    this.#description = description;
    this.#mode.textContent = this.#trackUp ? 'TRK' : 'N';
    this.#toggle.setAttribute('aria-pressed', String(this.#trackUp));
    this.#toggle.setAttribute('aria-description', description);
    this.#toggle.title = description;
    this.#toggle.classList.toggle('is-waiting', waiting);
  };
}
