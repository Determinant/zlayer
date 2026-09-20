/** Request CPU-friendly storage for numeric pixels and worker bitmap transfers.
 * Default accelerated storage corrupted tiles in WebKit; see graphics-compatibility.md. */
export function createPixelContext(width: number, height: number): OffscreenCanvasRenderingContext2D {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Pixel canvas unavailable');
  return context;
}
