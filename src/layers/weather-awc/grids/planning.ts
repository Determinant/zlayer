import type { AwcGridMode } from '@zlayer/contracts';
import { currentFrame } from '../time';
import { gridKey } from './format';
import type { ForecastFrame, ForecastManifest } from './native-source';
import { GRID_RETRY_MS, type FrameReceipt } from './receipts';
import { windFrames } from './wind-levels';

export type GridInput = { enabled: boolean; mode: AwcGridMode; altitude: number; time: number; online: boolean; visible: boolean;
  concurrency?: number; prepareTimeline?: boolean; pausePreparation?: boolean };
export type PlannedFrame = { frame: ForecastFrame; key: string };
export type GridPreparation = { ready: number; total: number; failed: number; limited?: boolean; error?: string };
export const framesAt = (manifest: ForecastManifest, altitude: number): ForecastFrame[] => manifest.product === 'winds'
  ? windFrames(manifest, altitude) : manifest.frames.filter(frame => manifest.product !== 'icing' || frame.altitudeFtMsl === altitude);

export function gridScope(manifest: ForecastManifest, input: GridInput, now: number) {
  const frames = framesAt(manifest, input.altitude), times = frames.map(frame => frame.validTime);
  const current = currentFrame(times, now, manifest.cadenceMs) ?? now;
  const selectedTime = currentFrame(times, input.time, manifest.cadenceMs);
  const horizon = frames.filter(frame => frame.validTime >= current || frame.validTime === selectedTime)
    .sort((a, b) => a.validTime - b.validTime).map(frame => ({ frame, key: gridKey(manifest, frame) }));
  const selected = horizon.find(item => item.frame.validTime === selectedTime);
  const index = horizon.findIndex(item => item.frame.validTime === (selectedTime ?? current));
  const nearby = index < 0 ? [] : [horizon[index], horizon[index + 1], horizon[index - 1]].filter((item): item is PlannedFrame => !!item);
  return { selected, horizon, nearby, saves: input.online && input.prepareTimeline !== false ? horizon : nearby };
}

/** Decide background starts, progress and retry timing from observed state.
 * Acquisition, catalog publication and receipt changes stay with their owners. */
export function planPreparation(scope: ReturnType<typeof gridScope>, demand: GridInput,
  receipts: ReadonlyMap<string, FrameReceipt>, live: {
    selectedPending: boolean; dataReady: boolean; catalogSaved: boolean; storageError: boolean;
    saving: ReadonlySet<string>; warm: ReadonlySet<string>;
  }) {
  const limited = live.storageError || scope.saves.some(item => receipts.get(item.key)?.saved === false);
  // The selected read retains its admission while optional storage completes.
  const capacity = demand.pausePreparation || live.selectedPending && (!live.dataReady || !demand.online) ? 0
    : Math.max(0, (demand.concurrency ?? 2) - Number(live.selectedPending) - live.saving.size);
  // A first successful nearby receipt unlocks catalog persistence and distant work.
  const work = live.catalogSaved ? scope.saves : scope.nearby;
  const starts = work.filter(item => !live.saving.has(item.key) && !receipts.get(item.key)?.error &&
    (item.key !== scope.selected?.key || live.dataReady && !live.selectedPending) &&
    (live.warm.has(item.key) || demand.online && !limited && receipts.get(item.key)?.saved !== true))
    .sort((a, b) => Number(live.warm.has(b.key)) - Number(live.warm.has(a.key)) ||
      Math.abs(a.frame.validTime - demand.time) - Math.abs(b.frame.validTime - demand.time) || b.frame.validTime - a.frame.validTime)
    .slice(0, capacity);
  const errors = scope.saves.flatMap(item => receipts.get(item.key)?.error ?? []);
  const preparation: GridPreparation | undefined = !demand.online || !scope.saves.length ? undefined : {
    ready: live.catalogSaved ? scope.saves.filter(item => receipts.get(item.key)?.saved === true).length : 0,
    total: scope.saves.length, failed: errors.length, ...(limited ? { limited: true } : {}), ...(errors.length ? { error: errors[0]!.message } : {}),
  };
  const retryAt = Math.min(...errors.map(error => error.at + GRID_RETRY_MS));
  return { starts, preparation, retryAt };
}
