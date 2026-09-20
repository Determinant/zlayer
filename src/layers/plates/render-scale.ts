// Each backing canvas is limited to 32 MiB, including during native pinch zoom.
export const MAX_PDF_CANVAS_PIXELS = 8_388_608;
const MAX_CANVAS_SIDE = 8192;

export function pdfCanvasSize(width: number, height: number, pixelRatio: number) {
  const scale = Math.min(pixelRatio, Math.sqrt(MAX_PDF_CANVAS_PIXELS / (width * height)),
    MAX_CANVAS_SIDE / width, MAX_CANVAS_SIDE / height);
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}
