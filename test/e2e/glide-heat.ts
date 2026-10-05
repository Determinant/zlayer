import type { Page } from '@playwright/test';

/** The Glide fixture preserves the framebuffer. Read actual rendered colors,
 * independent of whether shading uses an image source or retained textures. */
export async function heatPixels(page: Page, coordinate?: [number, number]): Promise<number> {
  return page.evaluate(async coordinate => {
    const map = window.glideAudit.map;
    await new Promise<void>(resolve => { map.once('render', () => resolve()); map.triggerRepaint(); });
    const canvas = map.getCanvas(), gl = canvas.getContext('webgl2')!;
    let x = 0, y = 0, width = canvas.width, height = canvas.height;
    if (coordinate) {
      const p = map.project(coordinate), scale = canvas.width / canvas.clientWidth;
      x = Math.floor(p.x * scale); y = canvas.height - 1 - Math.floor(p.y * scale); width = height = 1;
    }
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(x, y, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let shaded = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const r = pixels[i]!, g = pixels[i + 1]!, b = pixels[i + 2]!;
      if (g > r + 20 && g > b + 20 || b > r + 20 && r > g + 20) shaded++;
    }
    return shaded;
  }, coordinate);
}
