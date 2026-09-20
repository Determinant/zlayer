import { createPixelContext } from '../../src/core/graphics/pixel-context';

type Request = { id: number; accelerated?: boolean; image?: ImageBitmap };
const send = self.postMessage.bind(self) as (data: unknown, transfer: Transferable[]) => void;
self.onmessage = async ({ data: { id, accelerated, image } }: MessageEvent<Request>) => {
  const context = accelerated ? new OffscreenCanvas(512, 512).getContext('2d')! : createPixelContext(512, 512);
  const canvas = context.canvas;
  try {
    if (image) {
      try { context.drawImage(image, 0, 0); } finally { image.close(); }
      const pixels = context.getImageData(0, 0, 512, 512).data;
      const samples = [[50, 50], [300, 50], [50, 300], [300, 300]].map(([x, y]) =>
        Array.from(pixels.slice((y! * 512 + x!) * 4, (y! * 512 + x!) * 4 + 4)));
      send({ id, samples }, []);
      return;
    }
    const pixels = new Uint8ClampedArray(256 * 256 * 4);
    for (let quadrant = 0; quadrant < 4; quadrant++) {
      for (let i = 0; i < pixels.length; i += 4) {
        pixels[i] = id % 256; pixels[i + 1] = quadrant * 64;
        pixels[i + 2] = 255 - id % 256; pixels[i + 3] = 255;
      }
      context.putImageData(new ImageData(pixels, 256, 256), quadrant % 2 * 256, Math.floor(quadrant / 2) * 256);
      // Match production's four concurrent jobs yielding between subtiles.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    const bitmap = canvas.transferToImageBitmap();
    send({ id, image: bitmap }, [bitmap]);
  } finally { canvas.width = canvas.height = 0; }
};
