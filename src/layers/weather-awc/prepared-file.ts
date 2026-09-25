/** Authenticate prepared files before decoding or optional browser publication. */
export async function authenticatePreparedFile(bytes: ArrayBuffer, sha256: string): Promise<void> {
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
  if (hash !== sha256) throw new Error('Weather artifact checksum mismatch');
}
export async function preparedJson(bytes: ArrayBuffer, sha256: string): Promise<unknown> {
  await authenticatePreparedFile(bytes, sha256);
  return JSON.parse(new TextDecoder().decode(bytes));
}
