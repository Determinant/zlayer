import { isSha256 } from './validation.js';

export type JsonReferenceIdentity = {
  /** Digest of the validated, parsed export; dates and counts are not identities. */
  jsonSha256?: string;
  /** Legacy saved metadata can use surviving cache bytes, but cannot safely repair. */
  cacheOnly?: boolean;
};

export function hasJsonReferenceIdentity(value: Record<string, unknown>): boolean {
  return (value.jsonSha256 === undefined || isSha256(value.jsonSha256)) &&
    (value.cacheOnly === undefined || typeof value.cacheOnly === 'boolean');
}
