/** Authenticate prepared files before decoding or optional browser publication. */
export async function preparedJson(bytes: ArrayBuffer, sha256: string): Promise<unknown> {
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
  if (hash !== sha256) throw new Error('Weather artifact checksum mismatch');
  return JSON.parse(new TextDecoder().decode(bytes));
}
