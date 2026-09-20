import { isTafReport } from '@zlayer/contracts';

/** Check the deployed route, which a frontend build cannot install. */
export async function checkTafProxy(origin: string, request: typeof fetch = fetch): Promise<void> {
  const url = new URL('/weather/tafs.json?ids=KSFO&format=json', origin);
  const response = await request(url, { cache: 'no-store', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  // A station may temporarily have no forecast; that is a working proxy.
  if (response.status === 204) return;
  let body: unknown;
  try { body = await response.json(); }
  catch { throw new Error(`${url}: expected TAF JSON, received a non-JSON response`); }
  if (!Array.isArray(body) || !body.every(isTafReport) || body.some(report => report.icaoId !== 'KSFO')) {
    throw new Error(`${url}: invalid TAF response for KSFO`);
  }
}

if (import.meta.main) {
  try {
    await checkTafProxy(process.argv[2] ?? 'https://zlayer.tedyin.com');
    console.log('Production TAF proxy check passed.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    console.error('Check the live /weather/tafs.json proxy before publishing; see ops/README.md.');
    process.exitCode = 1;
  }
}
