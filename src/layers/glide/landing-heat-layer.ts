import type { CustomLayerInterface, Map as MapLibreMap } from 'maplibre-gl';
import { project } from '../../core/geo/route-corridor';
import type { LandingHeatTile, LandingHeatUpdate } from './landing-heat-tiles';

const vertexSource = `#version 300 es
layout(location = 0) in vec2 a_position;
uniform mat4 u_matrix;
uniform vec4 u_rectangle;
out vec2 v_uv;
void main() {
  v_uv = a_position;
  gl_Position = u_matrix * vec4(u_rectangle.xy + a_position * u_rectangle.zw, 0.0, 1.0);
}`;
const fragmentSource = `#version 300 es
precision highp float;
uniform sampler2D u_image;
uniform float u_level;
in vec2 v_uv;
out vec4 color;
void main() {
  vec4 pixel = textureLod(u_image, v_uv, u_level);
  color = vec4(pixel.rgb * pixel.a, pixel.a);
}`;

type Resident = {
  extent: LandingHeatTile['extent']; vertexCount: number; maxLevel: number; levelBias: number;
  canonical: { z: number; x: number; y: number }; wrap: number; rectangle: [number, number, number, number];
  failures: number; blocked: boolean;
  pending?: Pick<LandingHeatTile, 'vertices' | 'levels'>;
  gpu?: { texture: WebGLTexture; buffer: WebGLBuffer; vao: WebGLVertexArrayObject };
};
function residentTile(tile: LandingHeatTile): Resident {
  const [w, n, e, s] = tile.extent;
  const z = Math.max(0, Math.min(22, Math.floor(-Math.log2(Math.max(e - w, s - n))))), scale = 2 ** z;
  const x = Math.floor(w * scale), y = Math.floor(n * scale);
  return { extent: tile.extent, vertexCount: tile.vertices.length / 2, maxLevel: tile.levels.length - 1,
    levelBias: Math.log2(4 * tile.levels[0]!.width / (512 * (e - w))),
    canonical: { z, x: (x % scale + scale) % scale, y }, wrap: Math.floor(x / scale),
    rectangle: [(w * scale - x) * 8192, (n * scale - y) * 8192, (e - w) * scale * 8192, (s - n) * scale * 8192],
    failures: 0, blocked: false, pending: { vertices: tile.vertices, levels: tile.levels } };
}

/** Consume error flags only around new allocations, never on a warm draw. The
 * context is shared with MapLibre, so pre-existing flags are not our receipt.
 * WebGL has a finite set of error flags; the bound also covers context loss. */
function allocationErrors(gl: WebGL2RenderingContext): boolean {
  let failed = false;
  for (let i = 0; i < 8; i++) {
    if (gl.getError() === gl.NO_ERROR) break;
    failed = true;
  }
  return failed;
}

/** Commit all resources together. Allocation failure need not throw or lose the
 * context; keep the CPU body until buffer and every mip have been accepted. */
function uploadResident(gl: WebGL2RenderingContext, resident: Resident): boolean {
  const pending = resident.pending!;
  let texture: WebGLTexture | null = null, buffer: WebGLBuffer | null = null, vao: WebGLVertexArrayObject | null = null;
  try {
    allocationErrors(gl);
    texture = gl.createTexture(); buffer = gl.createBuffer(); vao = gl.createVertexArray();
    if (!texture || !buffer || !vao) return false;
    gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, pending.vertices, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    if (allocationErrors(gl) || gl.isContextLost()) return false;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    pending.levels.forEach((level, i) => gl.texImage2D(gl.TEXTURE_2D, i, gl.RGBA, level.width, level.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, level.rgba as Uint8ClampedArray<ArrayBuffer>));
    if (allocationErrors(gl) || gl.isContextLost()) return false;
    resident.gpu = { texture, buffer, vao }; resident.failures = 0;
    // The worker retains the recovery copy after a successful upload. Until
    // then, this body makes the resident key reproducible even after failure.
    delete resident.pending;
    return true;
  } catch { return false; }
  finally {
    if (!resident.gpu) { gl.deleteTexture(texture); gl.deleteBuffer(buffer); gl.deleteVertexArray(vao); }
  }
}

/** Mercator geographic tiles stay resident on the GPU while off screen. Camera
 * movement changes matrices and mip selection only: no composition or uploads.
 * The mask mesh clips every mip to the same route and source ownership geometry. */
export function createLandingHeatLayer(id: string, onFailureChange: () => void = () => {}) {
  const residents = new Map<string, Resident>();
  let map: MapLibreMap | undefined, context: WebGL2RenderingContext | undefined, program: WebGLProgram | undefined;
  let uniforms: { matrix: WebGLUniformLocation | null; rectangle: WebGLUniformLocation | null; level: WebGLUniformLocation | null; image: WebGLUniformLocation | null } | undefined;
  let visible = false, failed = false, retryTimer: ReturnType<typeof setTimeout> | undefined;
  const reportFailure = () => {
    const next = visible && [...residents.values()].some(resident => resident.failures > 0);
    if (failed !== next) { failed = next; onFailureChange(); }
  };
  const pause = () => { clearTimeout(retryTimer); retryTimer = undefined; };
  const retryable = () => !!map && visible && !document.hidden && !context?.isContextLost();
  const scheduleRetry = () => {
    if (retryTimer !== undefined || !retryable() || ![...residents.values()].some(resident => resident.blocked && resident.failures === 1)) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      if (!retryable()) return;
      let changed = false;
      for (const resident of residents.values()) if (resident.blocked && resident.failures === 1) { resident.blocked = false; changed = true; }
      if (changed) map?.triggerRepaint();
    }, 100);
  };
  const release = (resident: Resident) => {
    if (!resident.gpu || !context) return;
    context.deleteTexture(resident.gpu.texture); context.deleteBuffer(resident.gpu.buffer); context.deleteVertexArray(resident.gpu.vao);
    delete resident.gpu;
  };
  const layer: CustomLayerInterface = {
    id, type: 'custom', renderingMode: '2d',
    onAdd(target, gl) {
      map = target; context = gl;
      const shaders: WebGLShader[] = [];
      const next = gl.createProgram();
      if (!next) throw new Error('Landing shading program unavailable');
      try {
        for (const [type, source] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSource]] as const) {
          const shader = gl.createShader(type);
          if (!shader) throw new Error('Landing shading shader unavailable');
          shaders.push(shader); gl.shaderSource(shader, source); gl.compileShader(shader);
          if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'Landing shading shader failed');
          gl.attachShader(next, shader);
        }
        gl.linkProgram(next);
        if (!gl.getProgramParameter(next, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(next) ?? 'Landing shading link failed');
        program = next;
        uniforms = { matrix: gl.getUniformLocation(next, 'u_matrix'), rectangle: gl.getUniformLocation(next, 'u_rectangle'),
          level: gl.getUniformLocation(next, 'u_level'), image: gl.getUniformLocation(next, 'u_image') };
      } catch (error) { gl.deleteProgram(next); throw error; }
      finally { for (const shader of shaders) gl.deleteShader(shader); }
    },
    render(gl, options) {
      if (!visible || !map || !program || !uniforms || gl.isContextLost()) return;
      const bounds = map.getBounds(), nw = project([bounds.getWest(), bounds.getNorth()]), se = project([bounds.getEast(), bounds.getSouth()]);
      const zoom = map.getZoom();
      gl.useProgram(program); gl.activeTexture(gl.TEXTURE0); gl.uniform1i(uniforms.image, 0);
      gl.disable(gl.CULL_FACE); gl.disable(gl.DEPTH_TEST); gl.disable(gl.STENCIL_TEST);
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      let attempted = false;
      try {
        for (const resident of residents.values()) {
          const [w, n, e, s] = resident.extent;
          if (s < nw[1] || n > se[1]) continue;
          const first = Math.ceil(nw[0] - e), last = Math.floor(se[0] - w);
          if (first > last) continue;
          if (!resident.gpu) {
            if (resident.blocked) continue;
            attempted = true;
            if (!uploadResident(gl, resident)) {
              if (gl.isContextLost()) return;
              resident.failures = Math.min(2, resident.failures + 1); resident.blocked = true;
              continue;
            }
          }
          gl.bindVertexArray(resident.gpu!.vao); gl.bindTexture(gl.TEXTURE_2D, resident.gpu!.texture);
          gl.uniform1f(uniforms.level, Math.max(0, Math.min(resident.maxLevel, Math.floor(resident.levelBias - zoom))));
          // Tile-local matrices avoid float32 world-coordinate jitter at close zoom.
          gl.uniform4f(uniforms.rectangle, ...resident.rectangle);
          for (let copy = first; copy <= last; copy++) {
            const projection = options.getProjectionData({ tileID: { wrap: copy + resident.wrap, canonical: resident.canonical } });
            gl.uniformMatrix4fv(uniforms.matrix, false, projection.mainMatrix);
            gl.drawArrays(gl.TRIANGLES, 0, resident.vertexCount);
          }
        }
      } finally {
        // Custom-layer exceptions bypass MapLibre's state restoration. Failed
        // allocations return normally and always leave its VAO unbound.
        gl.bindVertexArray(null);
        if (attempted) { reportFailure(); scheduleRetry(); }
      }
    },
    onRemove() {
      for (const resident of residents.values()) release(resident);
      pause(); residents.clear(); visible = false; reportFailure();
      if (program) context?.deleteProgram(program);
      program = undefined; uniforms = undefined; context = undefined; map = undefined;
    },
  };
  return {
    layer,
    get failed() { return failed; },
    pause,
    retry() {
      if (!retryable()) return;
      pause();
      let changed = false;
      for (const resident of residents.values()) if (resident.blocked) { resident.blocked = false; changed = true; }
      // Failure remains visible until a later upload actually succeeds. New
      // camera/recovery demand permits one attempt, not another polling loop.
      if (changed) map?.triggerRepaint();
    },
    keys: () => [...residents.keys()],
    set(tiles: LandingHeatUpdate[]) {
      // Validate before changing the displayed set: a missing body must not
      // acknowledge a snapshot that the renderer cannot reproduce.
      for (const tile of tiles) if (!tile.levels && !residents.has(tile.key)) throw new Error('Missing retained landing shading');
      const keep = new Set(tiles.map(tile => tile.key));
      for (const [key, resident] of residents) if (!keep.has(key)) { release(resident); residents.delete(key); }
      for (const tile of tiles) if (!residents.has(tile.key) && tile.levels) residents.set(tile.key, residentTile(tile));
      visible = tiles.length > 0;
      if (!visible) pause();
      reportFailure(); scheduleRetry(); map?.triggerRepaint();
    },
    hide() { pause(); visible = false; reportFailure(); map?.triggerRepaint(); },
    clear() {
      pause();
      for (const resident of residents.values()) release(resident);
      residents.clear(); visible = false; reportFailure(); map?.triggerRepaint();
    },
  };
}
