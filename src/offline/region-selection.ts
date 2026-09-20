import type { DownloadPlan } from './downloads';

/** Selection is durable; transfer progress and file availability are not. The
 * legacy on-disk envelope is kept readable by older app versions. */
export type RegionSelection = { active?: DownloadPlan; staged?: DownloadPlan };

export function regionSelection(plan: DownloadPlan): RegionSelection {
  if (plan.completedAt) return { active: plan };
  return { staged: plan, ...(plan.previous ? { active: plan.previous } : {}) };
}

/** Copy only plan metadata. Never persist Download's progress, errors or state. */
export function planMetadata(plan: DownloadPlan): DownloadPlan {
  return { id: plan.id, regionId: plan.regionId, title: plan.title, revision: plan.revision,
    files: plan.files, references: plan.references,
    ...(plan.bounds ? { bounds: plan.bounds } : {}),
    ...(plan.catalog ? { catalog: plan.catalog } : {}),
    ...(plan.snapshotId ? { snapshotId: plan.snapshotId } : {}),
  };
}

export function stagedPlan(next: DownloadPlan, prior?: DownloadPlan): DownloadPlan {
  // Legacy selections predate the activation receipt. Keep them as candidates
  // until adoption has verified their exact dependencies.
  const active = prior && (regionSelection(prior).active ?? (!prior.snapshotId ? prior : undefined));
  return { ...planMetadata(next), ...(active ? { previous: { ...planMetadata(active),
    ...(active.completedAt ? { completedAt: active.completedAt } : {}) } } : {}) };
}

export function activatedPlan(plan: DownloadPlan, completedAt = Date.now()): DownloadPlan {
  return { ...planMetadata(plan), completedAt };
}

export function isActivated(plan: DownloadPlan): boolean {
  // Old records are adopted only after their durable files have been checked.
  return !plan.snapshotId || !!plan.completedAt;
}
