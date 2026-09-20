// Start the production fixture server with `node test/e2e/server.mjs` first.
// Usage: node tools/benchmark-graphics.mjs [chromium|firefox|webkit] [terrain|raster]
// Firefox on a Linux software renderer: xvfb-run -a node tools/benchmark-graphics.mjs firefox
import { chromium, firefox, webkit } from 'playwright';

const name = process.argv[2] ?? 'webkit';
const engine = { chromium, firefox, webkit }[name];
if (!engine) throw new Error(`Unknown browser: ${name}`);
const browser = await engine.launch({ headless: name !== 'firefox' });
try {
  const page = await browser.newPage();
  const origin = `http://127.0.0.1:${process.env.ZLAYER_TEST_PORT ?? 4197}`;
  await page.goto(`${origin}/test/browser/graphics.html`);
  await page.waitForFunction(() => document.body.dataset.idle === 'true');
  if (process.argv[3] === 'raster') {
    const result = await page.evaluate(async () => {
      const source = new OffscreenCanvas(256, 256), context = source.getContext('2d');
      context.fillStyle = 'rgba(255,128,0,0.5)'; context.fillRect(0, 0, 256, 256);
      const input = await createImageBitmap(source, { premultiplyAlpha: 'premultiply' });
      const gl = document.createElement('canvas').getContext('webgl2');
      const texture = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 256, 256);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      const results = [];
      try {
        for (let round = -1; round < 5; round++) {
          for (const explicit of (round % 2 ? [false, true] : [true, false])) {
            const count = round < 0 ? 16 : 128;
            gl.finish(); const begin = performance.now();
            for (let i = 0; i < count; i++) {
              const canvas = new OffscreenCanvas(256, 256), drawing = canvas.getContext('2d');
              for (let quadrant = 0; quadrant < 4; quadrant++) {
                drawing.drawImage(input, quadrant % 2 * 128, Math.floor(quadrant / 2) * 128, 128, 128);
              }
              const bitmap = explicit ? await createImageBitmap(canvas, { premultiplyAlpha: 'premultiply' })
                : canvas.transferToImageBitmap();
              canvas.width = canvas.height = 0;
              gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
              bitmap.close();
            }
            gl.finish();
            if (round >= 0) results.push({ round, explicit, count, elapsedMs: performance.now() - begin });
          }
        }
        return results;
      } finally {
        input.close(); source.width = source.height = 0;
        gl.deleteTexture(texture); gl.getExtension('WEBGL_lose_context').loseContext();
      }
    });
    console.log(JSON.stringify({ engine: name, kind: 'raster', results: result }));
  } else {
    for (const accelerated of [true, false]) {
      await page.evaluate(mode => window.graphicsFixture.bitmapTransfers(mode, 32), accelerated);
    }
    for (let round = 0; round < 5; round++) {
      for (const accelerated of (round % 2 ? [false, true] : [true, false])) {
        const result = await page.evaluate(mode => window.graphicsFixture.bitmapTransfers(mode, 128), accelerated);
        console.log(JSON.stringify({ engine: name, round, accelerated, ...result }));
      }
    }
  }
} finally { await browser.close(); }
