import { VERIFIED_SHA256_HEADER } from './cache-names';

export type ArtifactIdentity = { byteLength?: number; sha256?: string };

/** Only trust receipts read from Cache Storage, committed with verified bytes.
 * A server-supplied header must never bypass verification of a new download. */
export function verificationReceipt(headers: Headers, expected: ArtifactIdentity = {}): {
  byteLength: number; sha256: string;
} | undefined {
  const sha256 = headers.get(VERIFIED_SHA256_HEADER) ?? '';
  const byteLength = Number(headers.get('content-length'));
  if (!/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(byteLength) || byteLength <= 0 ||
    (expected.byteLength !== undefined && byteLength !== expected.byteLength) ||
    (expected.sha256 !== undefined && sha256 !== expected.sha256.toLowerCase())) return undefined;
  return { byteLength, sha256 };
}
