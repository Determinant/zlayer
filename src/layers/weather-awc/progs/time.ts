import type { SurfaceFrame, SurfaceProduct } from '@zlayer/contracts';
import type { SurfaceState } from './client';

export type SurfaceStates = Record<SurfaceProduct, SurfaceState>;
/** Native snapshots only: never interpolate a front, select a future analysis,
 * or carry the final forecast forward beyond its published horizon. */
export function surfaceFrame(products: SurfaceStates, selected: number | null, now: number): { product: SurfaceProduct; frame?: SurfaceFrame; nextTime?: number } {
  const analysis = products.analysis.snapshot?.frames[0];
  const recentAnalysis = analysis && analysis.validTime <= now && now - analysis.validTime < 6 * 3600_000 ? analysis : undefined;
  if (selected === null) return { product: 'analysis', ...(recentAnalysis ? { frame: recentAnalysis } : {}) };
  const frames = products.forecast.snapshot?.frames ?? [];
  // Other products may add stops between Now and the first published prog.
  // Keep the current analysis there, with its own valid time still visible.
  if (recentAnalysis && selected >= recentAnalysis.validTime && frames[0] && selected < frames[0].validTime) {
    return { product: 'analysis', frame: recentAnalysis, nextTime: frames[0].validTime };
  }
  const index = frames.reduce((previous, frame, index) => frame.validTime <= selected ? index : previous, -1);
  const frame = frames[index], next = frames[index + 1];
  return { product: 'forecast', ...(frame && (frame.validTime === selected || next && selected < next.validTime)
    ? { frame, ...(next ? { nextTime: next.validTime } : {}) } : {}) };
}
export function surfaceStatus(record: SurfaceState, now: number) {
  const snapshot = record.snapshot;
  const age = snapshot ? now - snapshot.checkedAt : undefined;
  const stale = !record.checkedAt || age === undefined || age < 0 || age > 10 * 60_000 || !!record.error ||
    !!snapshot && snapshot.frames.some(frame => now - frame.referenceTime > (snapshot.product === 'analysis' ? 6 : 36) * 3600_000);
  return { age, stale, label: record.loading ? 'Refreshing…' : record.error ? 'Refresh failed' : !snapshot ? 'Not checked' : stale ? 'Cached / unverified' : 'Checked' };
}
