import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { Map, CustomRenderMethodInput } from 'maplibre-gl';
import { createLandingHeatLayer } from '../src/layers/glide/landing-heat-layer';
import { landingHeatPyramid, type LandingHeatTile } from '../src/layers/glide/landing-heat-tiles';

function fixture(t: TestContext, count = 64) {
  const original = globalThis.document;
  const document = { hidden: false };
  globalThis.document = document as Document;
  let now = 0, uploadCost = 0, uploads = 0, repaints = 0, draws = 0, fail = false, lost = false;
  let texture: object | null = null;
  const live = new Set<object>(), mips = new WeakMap<object, number>();
  const create = () => { const value = {}; live.add(value); return value; };
  const remove = (value: object) => { live.delete(value); };
  const methods = {
    NO_ERROR: 0, getError: () => 0, isContextLost: () => lost,
    createProgram: () => ({}), createShader: () => ({}), getShaderParameter: () => true, getProgramParameter: () => true,
    createTexture: () => fail ? null : create(), createBuffer: create, createVertexArray: create,
    deleteTexture: remove, deleteBuffer: remove, deleteVertexArray: remove,
    bindTexture: (_target: number, value: object) => { texture = value; },
    texImage2D: () => { uploads++; now += uploadCost; mips.set(texture!, (mips.get(texture!) ?? 0) + 1); },
    drawArrays: () => { assert.equal(mips.get(texture!), 9, 'only complete mip pyramids may draw'); draws++; },
  };
  const constants = new globalThis.Map<string, number>();
  const gl = new Proxy(methods, { get(target, name: string) {
    if (name in target) return Reflect.get(target, name);
    if (/^[A-Z_0-9]+$/.test(name)) { if (!constants.has(name)) constants.set(name, constants.size + 1); return constants.get(name); }
    return () => {};
  } }) as unknown as WebGL2RenderingContext;
  const map = { getBounds: () => ({ getWest: () => -180, getEast: () => 180, getNorth: () => 85, getSouth: () => -85 }),
    getZoom: () => 3, triggerRepaint: () => repaints++ } as unknown as Map;
  const heat = createLandingHeatLayer('heat');
  t.mock.method(performance, 'now', () => now);
  heat.layer.onAdd!(map, gl);
  const levels = landingHeatPyramid({ width: 256, height: 256, coverage: new Float32Array(256 ** 2).fill(255),
    preference: new Float32Array(256 ** 2).fill(255) });
  const tiles: LandingHeatTile[] = Array.from({ length: count }, (_, i) => ({ key: String(i), extent: [.4, .4, .41, .41], levels,
    vertices: new Float32Array([0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1]) }));
  const render = () => heat.layer.render(gl, { getProjectionData: () => ({ mainMatrix: new Float32Array(16) }) } as unknown as CustomRenderMethodInput);
  t.after(() => { heat.layer.onRemove!(map, gl); globalThis.document = original; });
  return { heat, tiles, render, document, live, get uploads() { return uploads; }, get repaints() { return repaints; }, get draws() { return draws; },
    set uploadCost(ms: number) { uploadCost = ms; }, set fail(value: boolean) { fail = value; }, set lost(value: boolean) { lost = value; } };
}

test('cold heat uploads progress across bounded frames and warm draws do not request more frames', t => {
  const f = fixture(t); f.heat.set(f.tiles);
  let frames = 0;
  while (f.uploads < 64 * 9 && frames++ < 64) {
    const before = f.uploads; f.render();
    const admitted = (f.uploads - before) / 9;
    assert.ok(admitted >= 1 && admitted < 64);
    const bytes = f.tiles[0]!.levels.reduce((n, mip) => n + mip.rgba.byteLength, f.tiles[0]!.vertices.byteLength);
    assert.ok(admitted * bytes <= 4 * 1024 * 1024);
  }
  assert.equal(f.uploads, 64 * 9); assert.ok(frames > 1 && frames < 64);
  const repaints = f.repaints, draws = f.draws;
  f.render(); f.render();
  assert.equal(f.uploads, 64 * 9); assert.equal(f.repaints, repaints); assert.equal(f.draws - draws, 128);
  assert.equal(f.live.size, 64 * 3);
  f.heat.clear(); assert.equal(f.live.size, 0); assert.deepEqual(f.heat.keys(), []);
});

test('slow uploads stop admission after one complete tile, and hiding or context loss stops pending work', t => {
  const f = fixture(t, 4); f.uploadCost = 1; f.heat.set(f.tiles); f.render();
  assert.equal(f.uploads, 9);
  f.heat.hide(); let repaints = f.repaints; f.render();
  assert.equal(f.uploads, 9); assert.equal(f.repaints, repaints);
  f.heat.set(f.tiles); f.document.hidden = true; repaints = f.repaints; f.render();
  assert.equal(f.uploads, 9); assert.equal(f.repaints, repaints);
  f.document.hidden = false; f.heat.retry(); assert.equal(f.repaints, repaints + 1, 'foreground demand resumes pending uploads');
  f.lost = true; f.render(); assert.equal(f.uploads, 9);
  f.lost = false; f.render(); assert.equal(f.uploads, 18);
  f.heat.clear(); repaints = f.repaints; f.render();
  assert.equal(f.uploads, 18); assert.equal(f.repaints, repaints); assert.equal(f.live.size, 0);
});

test('offscreen pending heat does not spin and failed allocations retain a retryable body', t => {
  const f = fixture(t, 1); f.tiles[0]!.extent = [.4, 2, .41, 2.01]; f.heat.set(f.tiles);
  const repaints = f.repaints; f.render();
  assert.equal(f.uploads, 0); assert.equal(f.repaints, repaints);
  f.heat.clear(); f.tiles[0]!.extent = [.4, .4, .41, .41]; f.heat.set(f.tiles);
  f.fail = true; f.render(); f.heat.pause();
  assert.equal(f.heat.failed, true); assert.equal(f.live.size, 0);
  const failedRepaints = f.repaints; f.render();
  assert.equal(f.repaints, failedRepaints); assert.equal(f.uploads, 0);
  f.fail = false; f.heat.retry(); f.render();
  assert.equal(f.uploads, 9); assert.equal(f.heat.failed, false); assert.equal(f.live.size, 3);
});
