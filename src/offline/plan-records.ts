import { bookUrl, isCatalogResponse, isRecord, isStrictBounds } from '@zlayer/contracts';
import { isReferenceResource } from '../core/data/references';
import type { DownloadPlan } from './downloads';

export const REGION_PREFIX = 'region:';

export function isDownloadPlan(value: unknown): value is DownloadPlan {
  if (!value || typeof value !== 'object') return false;
  const plan = value as DownloadPlan;
  return typeof plan.id === 'string' && typeof plan.title === 'string' && typeof plan.regionId === 'string' &&
    (plan.bounds === undefined || (Array.isArray(plan.bounds) && plan.bounds.length > 0 && plan.bounds.every(isStrictBounds))) &&
    (plan.catalog === undefined || (isCatalogResponse(plan.catalog) && plan.catalog.revision === plan.revision)) &&
    (plan.snapshotId === undefined || /^[a-f0-9]{64}$/.test(plan.snapshotId)) &&
    (plan.completedAt === undefined || (Number.isFinite(plan.completedAt) && plan.completedAt > 0)) &&
    (plan.previous === undefined || (isRecord(plan.previous) && plan.previous.previous === undefined && isDownloadPlan(plan.previous) &&
      plan.previous.id === plan.id && plan.previous.regionId === plan.regionId && plan.previous.revision === plan.revision)) &&
    typeof plan.revision === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(plan.revision) &&
    Array.isArray(plan.references) && plan.references.every(isReferenceResource) &&
    Array.isArray(plan.files) && plan.files.every(file => file && typeof file.url === 'string' && (
      file.kind === 'faa-pdf'
        ? /^https:\/\/aeronav\.faa\.gov\/d-tpp\/\d{4}\/[-\w]+\.pdf\?v=[^#]+$/i.test(file.url) &&
          file.byteLength === undefined && file.sha256 === undefined
        : ['chart', 'pdf'].includes(file.kind) && Number.isSafeInteger(file.byteLength) && file.byteLength > 0 &&
          typeof file.sha256 === 'string' && /^[a-f0-9]{64}$/.test(file.sha256)));
}

export function snapshotFilesIncluded(plan: DownloadPlan): boolean {
  try {
    return plan.references.every(reference => reference.id !== 'chart-supplements' || !reference.snapshot ||
      reference.snapshot.volumes.every(volume => plan.files.some(file => file.kind === 'pdf' &&
        file.url === bookUrl(volume, reference.url) && file.sha256 === volume.sha256 && file.byteLength === volume.byteLength)));
  } catch { return false; }
}
