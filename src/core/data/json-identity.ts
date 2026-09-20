import { sha256 } from '@noble/hashes/sha2.js';

/** Identity of parsed JSON metadata, independent of HTTP compression and whitespace. */
export function jsonIdentity(value: object): string {
  const digest = sha256(new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}
