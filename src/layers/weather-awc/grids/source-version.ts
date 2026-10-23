import { isRecord } from '@zlayer/contracts';

/** HRRR supplies a strong ETag. NOMADS currently exposes only modification time
 * and length; that fallback depends on the publisher updating Last-Modified. */
export type ModelMirror = 'noaa-hrrr-s3';
export type ModelVersion = { byteLength: number; mirror?: ModelMirror } & ({ etag: string } | { lastModified: string });
export const strongEtag = (value: unknown): value is string => typeof value === 'string' && /^"[\x21\x23-\x7e]{1,512}"$/.test(value);
export function isModelVersion(value: unknown): value is ModelVersion {
  return isRecord(value) && Number.isSafeInteger(value.byteLength) && Number(value.byteLength) > 0 &&
    (value.mirror === undefined || value.mirror === 'noaa-hrrr-s3') &&
    (strongEtag(value.etag) ? value.lastModified === undefined : value.etag === undefined &&
      typeof value.lastModified === 'string' && Number.isFinite(Date.parse(value.lastModified)) &&
      new Date(value.lastModified).toUTCString() === value.lastModified);
}
export const modelVersionKey = (version: ModelVersion | undefined): string => version === undefined ? ''
  : JSON.stringify([version.byteLength, 'etag' in version ? version.etag : null, 'lastModified' in version ? version.lastModified : null,
    ...(version.mirror ? [version.mirror] : [])]);
