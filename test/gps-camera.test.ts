import assert from 'node:assert/strict';
import test from 'node:test';
import type { HeadingSource, HeadingListener } from '../src/core/map/heading';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { createLayerStore } from '../src/core/layers/store';
import { createGpsCamera, type OrientationSource } from '../src/workspace/map/gps-camera';
import { project } from '../src/core/geo/route-corridor';
import { destination } from '../src/layers/ownship/position';

type Snapshot = ReturnType<OrientationSource['getSnapshot']>;
function setup(t: test.TestContext, trackUp = false, assistance: Partial<HeadingSource> = {}, initialZoom?: number) {
  const store = createLayerStore<Snapshot>({ enabled: true, state: 'acquiring', fix: null, centerRequestKind: 'explicit' as const, centerRequest: 0 });
  const listeners = new Map<string, Set<(event: object) => void>>();
  let center = { lng: 0, lat: 0 }, zoom = initialZoom ?? 7, bearing = 0, moving = false, stops = 0;
  let active: { options: { center?: [number, number]; zoom: number; bearing?: number }; event: object } | undefined;
  const calls: typeof active[] = [];
  const emit = (type: string, event = {}) => { for (const fn of listeners.get(type) ?? []) fn({ type, ...event }); };
  const finish = () => {
    const current = active; active = undefined; moving = false;
    if (current) {
      if (current.options.center) center = { lng: current.options.center[0], lat: current.options.center[1] };
      zoom = current.options.zoom; bearing = current.options.bearing ?? bearing;
    }
    emit('moveend', current?.event);
  };
  const map = {
    project(point: [number, number] | { lng: number; lat: number }) {
      const [lng, lat] = Array.isArray(point) ? point : [point.lng, point.lat];
      if (initialZoom !== undefined) {
        const [x, y] = project([lng, lat]);
        return { x: x * 512 * 2 ** zoom, y: y * 512 * 2 ** zoom };
      }
      return { x: lng * 100, y: lat * 100 };
    },
    getCenter: () => center, getZoom: () => zoom, getBearing: () => bearing, isMoving: () => moving,
    on(type: string, fn: (event: object) => void) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)!.add(fn); },
    off(type: string, fn: (event: object) => void) { listeners.get(type)?.delete(fn); },
    easeTo(options: NonNullable<typeof active>['options'], event: object) {
      active = { options, event }; calls.push(active); moving = true; emit('movestart', event);
    },
    stop() { stops++; const event = active?.event; active = undefined; moving = false; emit('moveend', event); },
  };
  const camera = createGpsCamera(map as unknown as MapLibreMap, { ...store, ...assistance }, trackUp, () => {});
  t.after(camera.dispose);
  const fix = (longitude = -122, accuracy = 5, request = store.getSnapshot().centerRequest,
    centerRequestKind: Snapshot['centerRequestKind'] = 'explicit') => store.publish({
    enabled: true, state: 'tracking', centerRequestKind, centerRequest: request, fix: { coordinates: [longitude, 37], accuracy, track: 90, time: (store.getSnapshot().fix?.time ?? 0) + 1 },
  });
  return { camera, store, calls, fix, finish, stops: () => stops, moving: () => moving,
    emit,
    progress: (value: number) => { zoom = value; },
    userMove: () => { moving = true; active = undefined; emit('movestart'); },
    listenerCount: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0) };
}

test('first and explicit GPS centers defer to user motion and select the latest usable fix', async t => {
  const s = setup(t);
  s.userMove(); s.fix(-122, 1500, 1);
  assert.equal(s.calls.length, 0);
  s.fix(-122, 5, 2); s.fix(-121, 5, 2);
  assert.equal(s.calls.length, 0);
  s.finish(); await Promise.resolve();
  assert.deepEqual(s.calls[0]!.options.center, [-121, 37]);
  assert.equal(s.calls[0]!.options.zoom, 9);
  s.finish(); s.fix(-120);
  assert.equal(s.calls.length, 1, 'north up preserves the camera after initial centering');
});

test('an interrupted explicit center keeps its zoom and latest fix despite ordinary GPS updates', t => {
  const s = setup(t, true, {}, 5);
  s.fix(-122, 5, 1); // Center requests zoom 9.
  s.progress(6);
  s.fix(-121.99);
  s.camera.hold('pointer', true);
  s.camera.hold('pointer', false);
  assert.equal(s.calls.at(-1)!.options.zoom, 9);
  assert.deepEqual(s.calls.at(-1)!.options.center, [-121.99, 37]);
  s.camera.hold('pointer', true);
  s.camera.resume(); // The newer explicit action preserves the current zoom.
  s.camera.hold('pointer', false);
  assert.equal(s.calls.at(-1)!.options.zoom, 6);
});

for (const trackUp of [false, true]) test(`a late initial fix cannot override manual browsing (track up ${trackUp})`, t => {
  const s = setup(t, trackUp);
  s.emit('dragstart', { originalEvent: {} });
  s.fix(-122, 5, 1, 'initial');
  assert.equal(s.calls.length, 0);
  assert.equal(s.camera.browsing(), trackUp);
  s.fix(-122, 5, 2, 'explicit');
  assert.deepEqual(s.calls.at(-1)!.options.center, [-122, 37]);
  assert.equal(s.camera.browsing(), false);
  s.finish();
  s.emit('dragstart', { originalEvent: {} });
  s.store.publish({ ...s.store.getSnapshot(), enabled: false, fix: null });
  s.store.publish({ ...s.store.getSnapshot(), enabled: true, state: 'acquiring' });
  s.fix(-121, 5, 3, 'initial');
  assert.deepEqual(s.calls.at(-1)!.options.center, [-121, 37], 'explicitly enabling GPS permits centering again');
});

test('presses and map inspection hold the camera, coalesce fixes and resume only after both release', async t => {
  const s = setup(t, true);
  s.fix();
  s.camera.hold('pointer', true);
  assert.equal(s.stops(), 1, 'stop the camera already moving under the finger');
  for (let i = 0; i < 10; i++) s.fix(-121 + i * .01);
  s.camera.hold('inspection', true);
  s.camera.hold('pointer', false);
  await Promise.resolve();
  assert.equal(s.calls.length, 1, 'neither fresh fixes nor releasing the long press moves an open menu');
  s.camera.hold('inspection', false);
  assert.equal(s.calls.length, 2);
  assert.deepEqual(s.calls[1]!.options.center, [-120.91, 37]);
  s.finish();
  assert.equal(s.camera.browsing(), false, 'inspection does not turn off following');
  s.camera.hold('pointer', true);
  s.fix(-120);
  s.store.publish({ ...s.store.getSnapshot(), state: 'stale' });
  s.camera.hold('pointer', false);
  assert.equal(s.calls.length, 2, 'GPS loss discards held movement');
});

for (const event of [{ type: 'dragstart', originalEvent: {} }, { type: 'rotatestart', originalEvent: {} },
  { type: 'movestart', originalEvent: { key: 'ArrowLeft' } }, { type: 'movestart', browseCamera: true }]) {
  test(`${event.type} browsing holds position and bearing through new fixes and GPS recovery`, t => {
    const s = setup(t, true);
    s.fix(); s.finish();
    s.emit(event.type, event);
    assert.equal(s.camera.browsing(), true);
    for (let i = 0; i < 10; i++) s.fix(-121 + i * .01);
    s.store.publish({ ...s.store.getSnapshot(), state: 'stale' });
    s.fix(-120);
    assert.equal(s.calls.length, 1);
    assert.equal(s.camera.getTargetBearing(), 90);
    s.camera.resume();
    assert.equal(s.camera.browsing(), false);
    assert.deepEqual(s.calls.at(-1)!.options.center, [-120, 37]);
    assert.equal(s.calls.at(-1)!.options.zoom, 7, 'Follow preserves the chosen zoom');
    s.finish();
    s.emit(event.type, event);
    s.fix(-119, 5, 1);
    assert.equal(s.camera.browsing(), false, 'Center aircraft also resumes following');
    assert.deepEqual(s.calls.at(-1)!.options.center, [-119, 37]);
  });
}

test('high-zoom stationary jitter stays idle while travel, flight and explicit centering still follow', t => {
  const s = setup(t, true, {}, 15), home: [number, number] = [-122, 37];
  let time = 0;
  const fix = (meters: number, speed: number | null = 0, centerRequest = 0) => s.store.publish({
    enabled: true, state: 'tracking', centerRequestKind: 'explicit', centerRequest,
    fix: { coordinates: destination(home, 90, meters), accuracy: 10, track: speed ? 90 : null, speed, time: ++time },
  });
  fix(5); s.finish();
  for (let i = 0; i < 60; i++) { fix(i % 2 ? -5 : 5, i % 3 ? 0 : null); s.finish(); }
  assert.equal(s.calls.length, 1, 'no map animations for a minute of parked drift, even after centering on a noisy fix');
  fix(30); s.finish();
  assert.equal(s.calls.length, 2, 'displacement beyond uncertainty still follows without velocity');
  fix(28, 60); s.finish();
  assert.equal(s.calls.length, 3, 'confirmed flight preserves fine position following');
  fix(27, 0, 1); s.finish();
  assert.equal(s.calls.length, 4, 'explicit centering bypasses the uncertainty threshold');
  s.emit('dragstart', { originalEvent: {} });
  fix(26);
  s.camera.resume();
  assert.deepEqual(s.calls.at(-1)!.options.center, destination(home, 90, 26), 'Follow also centers inside the uncertainty threshold');
  assert.equal(s.calls.at(-1)!.options.zoom, 15);
});

for (const trackUp of [false, true]) {
  test(`GPS centering cancels on disable, stale, poor accuracy and teardown (track up ${trackUp})`, t => {
    const s = setup(t, trackUp);
    let request = 0;
    for (const change of [{ enabled: false }, { state: 'stale' }, { fix: { coordinates: [-122, 37] as [number, number], accuracy: 101, track: 90, time: 0 } }]) {
      s.fix(-122, 5, ++request);
      assert.equal(s.moving(), true);
      s.store.publish({ ...s.store.getSnapshot(), ...change });
      assert.equal(s.moving(), false);
    }
    assert.equal(s.stops(), 3);
    s.fix(-122, 5, ++request); s.camera.dispose();
    assert.equal(s.stops(), 4);
    assert.equal(s.listenerCount(), 0);
    s.fix(-120, 5, ++request);
    assert.equal(s.calls.length, 4, 'disposal removes source demand too');
  });
}

test('loss of GPS drops deferred centering without cancelling a user movement', t => {
  const s = setup(t, true);
  s.userMove(); s.fix();
  s.store.publish({ ...s.store.getSnapshot(), state: 'stale' });
  assert.equal(s.stops(), 0);
  s.finish();
  assert.equal(s.calls.length, 0);
  s.fix(); s.finish();
  assert.equal(s.calls.length, 1, 'fresh GPS resumes follow after the interruption');
});

test('track following coalesces fixes during animation, preserves zoom and becomes idle when unchanged', async t => {
  const s = setup(t, true);
  s.fix(-122); s.fix(-121); s.fix(-120);
  assert.equal(s.calls.length, 1);
  s.finish(); await Promise.resolve();
  assert.equal(s.calls.length, 2);
  assert.deepEqual(s.calls[1]!.options.center, [-120, 37]);
  assert.equal(s.calls[1]!.options.zoom, 7);
  s.finish(); s.fix(-120); s.fix(-120);
  assert.equal(s.calls.length, 2);
  s.camera.setTrackUp(false); s.finish();
  s.fix(-119);
  assert.equal(s.calls.length, 3, 'north-up rotation finishes without later GPS following');
});


test('subpixel GPS jitter does not animate the map, but accumulated movement and explicit centering do', t => {
  const s = setup(t, true);
  s.fix(-122); s.finish();
  for (const longitude of [-122.001, -121.999, -121.996]) s.fix(longitude);
  assert.equal(s.calls.length, 1);
  assert.deepEqual(s.store.getSnapshot().fix!.coordinates, [-121.996, 37], 'GPS position remains exact');
  s.fix(-121.99); s.finish();
  assert.equal(s.calls.length, 2);
  s.fix(-121.989, 5, 1);
  assert.equal(s.calls.length, 3, 'explicit centering bypasses the visual deadband');
  assert.deepEqual(s.calls.at(-1)!.options.center, [-121.989, 37]);
});


test('moveend reconciliation waits for a replacing camera command to install its movement', async t => {
  const s = setup(t, true);
  s.userMove(); s.fix(-122, 5, 1);
  s.finish();
  assert.equal(s.calls.length, 0, 'moveend must not start another animation synchronously');
  s.userMove(); // The new command installs its movement after stopping the old one.
  await Promise.resolve();
  assert.equal(s.calls.length, 0, 'the replacement command retains camera ownership');
  s.finish(); await Promise.resolve();
  assert.equal(s.calls.length, 1);
  s.finish(); s.camera.dispose(); await Promise.resolve();
  assert.equal(s.calls.length, 1, 'queued reconciliation cannot outlive disposal');
});

test('track noise does not rotate the map even when fresh positions need centering', t => {
  const s = setup(t, true);
  s.fix(); s.finish();
  for (let time = 2; time <= 60; time++) {
    s.store.publish({ ...s.store.getSnapshot(), fix: { coordinates: [-122 + time * .01, 37], accuracy: 5,
      track: 90 + (Math.floor((time - 2) / 3) % 2 ? -5 : 5), time } });
    assert.equal(s.calls.at(-1)!.options.bearing, 90);
    s.finish();
  }
});

test('heading demand follows camera mode and GPS quality without publishing Ownship snapshots', t => {
  let now = 0, acquired = 0, released = 0, notify: HeadingListener = () => {};
  t.mock.method(performance, 'now', () => now * 1000);
  const s = setup(t, false, { acquireHeading(listener) { acquired++; notify = listener; return () => { released++; }; } });
  s.store.publish({ enabled: true, state: 'tracking', centerRequestKind: 'explicit' as const, centerRequest: 0,
    fix: { coordinates: [-122, 37], accuracy: 5, track: 90, time: 0, speed: 55, estimated: false } });
  assert.equal(acquired, 0);
  s.camera.setTrackUp(true); s.finish();
  assert.equal(acquired, 1);
  let publications = 0;
  const unsubscribe = s.store.subscribe(() => { publications++; });
  notify({ degrees: 70, time: now, frame: 1 });
  now = .25; notify({ degrees: 73, time: now, frame: 1 }); s.finish();
  assert.equal(s.calls.at(-1)!.options.bearing, 90, 'a brief sensor change does not immediately rotate the map');
  for (let sample = 2; sample <= 10; sample++) {
    now = sample / 4; notify({ degrees: 73, time: now, frame: 1 }); s.finish();
  }
  assert.equal(s.calls.at(-1)!.options.bearing, 90, 'a three-degree sensor offset stays inside the map deadband');
  now = 2.75; notify({ degrees: 78, time: now, frame: 1 }); s.finish();
  now = 3; notify({ degrees: 78, time: now, frame: 1 }); s.finish();
  assert.ok(s.calls.at(-1)!.options.bearing! > 93, 'larger sustained motion still reaches the camera');
  assert.equal(publications, 0);
  s.store.publish({ ...s.store.getSnapshot(), fix: { ...s.store.getSnapshot().fix!, speed: 2 } });
  assert.equal(released, 1);
  s.store.publish({ ...s.store.getSnapshot(), fix: { ...s.store.getSnapshot().fix!, speed: 55 } });
  assert.equal(acquired, 2);
  s.camera.setTrackUp(false); s.finish(); assert.equal(released, 2);
  s.camera.setTrackUp(true); s.finish(); assert.equal(acquired, 3);
  s.store.publish({ ...s.store.getSnapshot(), state: 'paused' }); assert.equal(released, 3);
  s.store.publish({ ...s.store.getSnapshot(), state: 'tracking' }); assert.equal(acquired, 4);
  s.emit('dragstart', { originalEvent: {} }); assert.equal(released, 4, 'browsing releases camera-only sensor demand');
  s.camera.resume(); assert.equal(acquired, 5);
  s.camera.dispose(); assert.equal(released, 5);
  unsubscribe();
});
