import { TFR_DETAIL_REFRESH_MS, type TfrArea, type TfrNotice, type TfrWindow } from '@zlayer/contracts';

export function tfrDetailFresh(notice: TfrNotice, now: number): boolean {
  return notice.detailCheckedAt !== undefined && now >= notice.detailCheckedAt && now - notice.detailCheckedAt < TFR_DETAIL_REFRESH_MS;
}

const DAY = 86_400_000;
/** Published UTC windows, including recurring windows crossing midnight. */
function nextWindow(window: TfrWindow, now: number): { start: number; end: number } | undefined {
  const end = window.endsAt ?? Infinity;
  if (now >= end) return undefined;
  if (!window.daily) return { start: window.startsAt, end };
  const base = Math.floor(Math.max(now, window.startsAt) / DAY) * DAY;
  const { startSeconds, endSeconds, days } = window.daily;
  for (let offset = -1; offset <= 7; offset++) {
    const day = base + offset * DAY;
    if (!days.includes(new Date(day).getUTCDay())) continue;
    const start = Math.max(window.startsAt, day + startSeconds * 1000);
    const finish = Math.min(end, day + endSeconds * 1000 + (endSeconds <= startSeconds ? DAY : 0));
    if (finish > now && finish > start) return { start, end: finish };
  }
  return undefined;
}
export function tfrTiming(notice: TfrNotice, area: TfrArea, now: number): {
  status: 'active' | 'upcoming' | 'unknown'; boundary: number; startsAt: number; endsAt: number | null;
} | undefined {
  if (notice.endsAt !== null && now >= notice.endsAt) return undefined;
  if (area.windows === null) return { status: now < notice.startsAt ? 'upcoming' : 'unknown',
    boundary: now < notice.startsAt ? notice.startsAt : notice.endsAt ?? Infinity, startsAt: notice.startsAt, endsAt: notice.endsAt };
  const windows = area.windows.map(w => nextWindow(w, now)).filter(w => !!w);
  const active = windows.filter(w => w.start <= now).sort((a,b) => a.end - b.end)[0];
  const next = active ?? windows.sort((a,b) => a.start - b.start)[0];
  return next ? { status: active ? 'active' : 'upcoming', boundary: active ? next.end : next.start,
    startsAt: next.start, endsAt: Number.isFinite(next.end) ? next.end : null } : undefined;
}
