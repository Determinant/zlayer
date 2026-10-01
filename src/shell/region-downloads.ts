import { isDownloadActive, type Download, type DownloadPlan } from '../offline/downloads';
import { regionKey } from '../offline/region-selection';

export type RegionDownloadEntry = {
  key: string;
  plan: DownloadPlan;
  current: boolean;
  job: Download | undefined;
  active: DownloadPlan | undefined;
  problem: string | undefined;
};

/** One row per publisher/region; stored edition records remain independently resumable. */
export function regionDownloadEntries(plans: readonly { plan: DownloadPlan; problem?: string | undefined }[],
  jobs: readonly Download[]): RegionDownloadEntry[] {
  const entries = new Map(plans.map(({ plan, problem }) => [regionKey(plan), {
    key: regionKey(plan), plan, current: true, job: undefined, active: undefined, problem,
  } as RegionDownloadEntry]));
  const ordered = [...jobs].sort((a, b) => Number(isDownloadActive(b)) - Number(isDownloadActive(a)) ||
    b.revision.localeCompare(a.revision) || (b.completedAt ?? 0) - (a.completedAt ?? 0) || a.id.localeCompare(b.id));
  for (const job of ordered) {
    const key = regionKey(job);
    let entry = entries.get(key);
    if (!entry) { entry = { key, plan: job, current: false, job: undefined, active: undefined, problem: undefined }; entries.set(key, entry); }
    entry.job ??= job;
    const active = job.completedAt || job.state === 'complete' ? job : job.previous;
    if (active && (!entry.active || active.revision > entry.active.revision ||
      active.revision === entry.active.revision && (active.completedAt ?? 0) > (entry.active.completedAt ?? 0))) entry.active = active;
  }
  return [...entries.values()].sort((a, b) => a.plan.title.localeCompare(b.plan.title) || a.key.localeCompare(b.key));
}
