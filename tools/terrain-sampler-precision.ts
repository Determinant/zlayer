import type { Plugin } from 'vite';

/** MapLibre 6.9's color-relief samplers default to lowp. Numeric DEM/palette
 * bytes need highp: half-float rounding can turn a transparent edge opaque.
 * Keep this narrow build-time fix until upstream qualifies both samplers. */
export function terrainSamplerPrecision(): Plugin {
  const declaration = 'uniform sampler2D u_image;uniform vec4 u_unpack;uniform sampler2D u_elevation_stops;';
  return {
    name: 'terrain-sampler-precision', enforce: 'pre',
    transform(source, id) {
      if (!/\/maplibre-gl\/dist\/maplibre-gl\.mjs(?:\?.*)?$/.test(id)) return;
      const index = source.indexOf(declaration);
      if (index < 0 || index !== source.lastIndexOf(declaration)) {
        throw new Error('MapLibre color-relief shader changed; review the terrain sampler precision fix.');
      }
      return { code: source.replace(declaration, declaration.replaceAll('uniform sampler2D', 'uniform highp sampler2D')), map: null };
    },
  };
}
