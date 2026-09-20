/** Own the canvas through drawing and snapshot completion, including cancellation.
 * MapLibre needs premultiplied color; WebGL unpack flags cannot convert ImageBitmap
 * inputs. Choose the format at creation rather than using transferToImageBitmap. */
export async function renderRasterBitmap(size: number, signal: AbortSignal,
  draw: (context: OffscreenCanvasRenderingContext2D) => Promise<void>): Promise<ImageBitmap> {
  signal.throwIfAborted();
  const canvas = new OffscreenCanvas(size, size);
  try {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Raster drawing unavailable');
    await draw(context);
    signal.throwIfAborted();
    const bitmap = await createImageBitmap(canvas, { premultiplyAlpha: 'premultiply' });
    if (signal.aborted) { bitmap.close(); signal.throwIfAborted(); }
    return bitmap;
  } finally { canvas.width = canvas.height = 0; }
}
