import type { TfrState } from './tfr-client';
import { tfrDetailFresh, tfrTiming } from './tfr-time';

export type TfrAreaSelection = { noticeId: string; areaId: string };

/** Resolve identities against current source data and time, never retained map properties. */
export function selectedTfrAreas(state: TfrState, selected: readonly TfrAreaSelection[]) {
  const ids = new Set(selected.map(area => `${area.noticeId}:${area.areaId}`));
  return (state.snapshot?.notices ?? []).flatMap(notice => notice.areas.flatMap(area => {
    if (!area.geometry || !ids.has(`${notice.id}:${area.id}`)) return [];
    const timing = tfrTiming(notice, area, state.now);
    const issue = state.snapshot?.issues?.find(issue => issue.id === notice.id);
    return timing ? [{ notice, area, timing, issue }] : [];
  }));
}

/** Review access is independent of map geometry, activation and selection. */
export function tfrReviewNotices(state: TfrState) {
  const notices = new Map(state.snapshot?.notices.map(notice => [notice.id, notice]));
  const issues = new Map(state.snapshot?.issues?.map(issue => [issue.id, issue]));
  return [...new Set([...notices.keys(), ...issues.keys()])].sort().flatMap(id => {
    const notice = notices.get(id), issue = issues.get(id), reasons: string[] = [];
    if (issue) reasons.push(issue.reason === 'detail-invalid' ? 'FAA detail could not be validated' : 'FAA detail unavailable');
    if (notice) {
      if (!notice.areas.length || notice.areas.every(area => !area.geometry)) reasons.push('Boundary unavailable');
      else if (notice.areas.some(area => !area.geometry)) reasons.push('Some boundaries unavailable');
      if (notice.areas.some(area => !area.windows)) reasons.push('Schedule unconfirmed');
      if (notice.areas.some(area => area.lower === 'Check altitude' || area.upper === 'Check altitude')) reasons.push('Altitude unconfirmed');
      if (!tfrDetailFresh(notice, state.now)) reasons.push(notice.detailCheckedAt === undefined ? 'Detail age unconfirmed' : 'Detail needs recheck');
    } else reasons.push('No retained detail');
    return reasons.length ? [{ id, title: (issue ?? notice)!.title, notice, issue, reasons }] : [];
  });
}
