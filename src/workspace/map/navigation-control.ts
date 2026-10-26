import { NavigationControl, type Map as MapLibreMap } from 'maplibre-gl';
import { isBoolean, readUiState, writeUiState } from '../../core/storage/ui-state';
import { createGpsCamera, type OrientationSource } from './gps-camera';
export type { OrientationSource } from './gps-camera';

/** Zoom and an aviation orientation toggle sharing the existing GPS watch. */
export class MapNavigationControl extends NavigationControl {
  readonly #ownship: OrientationSource;
  readonly #toggle = document.createElement('button');
  readonly #mode = document.createElement('span');
  readonly #resume = document.createElement('button');
  #unbindPointer: (() => void) | undefined;
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
    this.#resume.type = 'button';
    this.#resume.className = 'map-follow-resume';
    this.#resume.textContent = 'Follow';
    this.#resume.setAttribute('aria-label', 'Resume track up');
    this.#resume.title = 'Resume track up · Center aircraft';
    this.#resume.hidden = true;
    this.#resume.addEventListener('click', () => this.#camera?.resume());
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
    container.append(this.#toggle, this.#resume);
    this.#map = map;
    const camera = this.#camera = createGpsCamera(map, this.#ownship, this.#trackUp, this.#update);
    const canvas = map.getCanvas(), document = canvas.ownerDocument;
    const touches = new Set<number>();
    let mousePressed = false;
    let release: ReturnType<typeof setTimeout> | undefined;
    const hold = () => {
      clearTimeout(release); release = undefined;
      camera.hold('pointer', true);
    };
    const released = () => {
      // Finish native click handlers before applying the queued camera. Listen
      // to MapLibre's mouse/touch lifecycle: compatibility mousedown after a tap
      // must hold (and retain) any follow animation resumed after touchend.
      clearTimeout(release);
      release = setTimeout(() => {
        release = undefined;
        if (!mousePressed && !touches.size) camera.hold('pointer', false);
      }, 0);
    };
    const mouseDown = () => { mousePressed = true; hold(); };
    const mouseUp = () => { if (mousePressed) { mousePressed = false; released(); } };
    const touchStart = (event: TouchEvent) => {
      for (const touch of Array.from(event.changedTouches)) touches.add(touch.identifier);
      hold();
    };
    const touchEnd = (event: TouchEvent) => {
      for (const touch of Array.from(event.changedTouches)) touches.delete(touch.identifier);
      released();
    };
    const blur = () => {
      clearTimeout(release); release = undefined; touches.clear(); mousePressed = false;
      camera.hold('pointer', false);
    };
    const visibility = () => { if (document.hidden) blur(); };
    canvas.addEventListener('mousedown', mouseDown, true);
    canvas.addEventListener('touchstart', touchStart, { capture: true, passive: true });
    document.addEventListener('mouseup', mouseUp);
    document.addEventListener('touchend', touchEnd);
    document.addEventListener('touchcancel', touchEnd);
    document.addEventListener('visibilitychange', visibility);
    document.defaultView?.addEventListener('blur', blur);
    this.#unbindPointer = () => {
      clearTimeout(release);
      canvas.removeEventListener('mousedown', mouseDown, true);
      canvas.removeEventListener('touchstart', touchStart, true);
      document.removeEventListener('mouseup', mouseUp);
      document.removeEventListener('touchend', touchEnd);
      document.removeEventListener('touchcancel', touchEnd);
      document.removeEventListener('visibilitychange', visibility);
      document.defaultView?.removeEventListener('blur', blur);
    };
    this.#update();
    return container;
  }

  override onRemove(): void {
    this.#unbindPointer?.(); this.#unbindPointer = undefined;
    this.#camera?.dispose();
    this.#camera = undefined;
    this.#map = undefined;
    super.onRemove();
  }

  /** Fit cameras at the intended orientation, including during a rotation. */
  getTargetBearing(): number {
    return this.#camera?.getTargetBearing() ?? this.#map?.getBearing() ?? 0;
  }

  setInspectionOpen(value: boolean): void { this.#camera?.hold('inspection', value); }

  readonly #update = (): void => {
    const map = this.#map;
    if (!map) return;
    const waiting = this.#camera?.waiting() ?? this.#trackUp;
    const browsing = this.#camera?.browsing() ?? false;
    if (this.#resume.hidden !== !browsing) this.#resume.hidden = !browsing;
    const disabled = !this.#camera?.canResume();
    if (this.#resume.disabled !== disabled) this.#resume.disabled = disabled;
    const description = this.#trackUp
      ? `Track up${browsing ? ' · Following paused' : ''}${waiting ? ' · Waiting for GPS track' : ''} · Switch to north up`
      : 'North up · Switch to track up';
    if (description === this.#description) return;
    this.#description = description;
    this.#mode.textContent = this.#trackUp ? 'TRK' : 'N';
    this.#toggle.setAttribute('aria-pressed', String(this.#trackUp));
    this.#toggle.setAttribute('aria-description', description);
    this.#toggle.title = description;
    this.#toggle.classList.toggle('is-waiting', waiting);
    this.#toggle.classList.toggle('is-browsing', browsing);
  };
}
