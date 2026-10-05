import type { TfrState } from './tfr-client';
import { tfrTiming } from './tfr-time';

export type TfrAreaSelection = { noticeId: string; areaId: string };

/** Resolve identities against current source data and time, never retained map properties. */
export function selectedTfrAreas(state: TfrState, selected: readonly TfrAreaSelection[]) {
  const ids = new Set(selected.map(area => `${area.noticeId}:${area.areaId}`));
  return (state.snapshot?.notices ?? []).flatMap(notice => notice.areas.flatMap(area => {
    if (!area.geometry || !ids.has(`${notice.id}:${area.id}`)) return [];
    const timing = tfrTiming(notice, area, state.now);
    return timing ? [{ notice, area, timing }] : [];
  }));
}
