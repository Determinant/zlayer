import { CONVERTER_VERSION, type NativeFrame, type NativeManifest } from './native-source';

/** One same-run terrain input, shared by every wind pressure level and forecast hour. */
export const terrainKey = (manifest: NativeManifest, frame: NativeFrame) =>
  JSON.stringify([CONVERTER_VERSION, 'model-terrain-v1', manifest.runTime, manifest.grid, frame.records.terrain]);
export const terrainPath = (manifest: NativeManifest, identity: string) => `winds/${manifest.runTime}-terrain-${identity}.zwt.gz`;

export function readModelTerrain(artifact: ArrayBuffer, grid: NativeManifest['grid']) {
  if (artifact.byteLength !== 168 + grid.width * grid.height * 4 || new DataView(artifact).getUint32(0, true) !== 1) {
    throw new Error('Invalid converted model terrain');
  }
  const signature = new TextDecoder().decode(new Uint8Array(artifact, 4, 162));
  if (!/^[a-f0-9]{162}$/.test(signature)) throw new Error('Invalid model terrain grid signature');
  const view = new DataView(artifact);
  const values = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1 ? new Float32Array(artifact, 168)
    : Float32Array.from({ length: grid.width * grid.height }, (_, i) => view.getFloat32(168 + i * 4, true));
  for (const value of values) {
    if (!Number.isNaN(value) && (!Number.isFinite(value) || value < -500 || value > 10000)) throw new Error('Invalid model terrain height');
  }
  return { signature, values };
}
