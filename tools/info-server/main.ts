import { resolve } from 'node:path';
import { createInfoServer } from './server.ts';
import { DEFAULT_WEATHER_CACHE_BYTES, DEFAULT_WEATHER_CACHE_ENTRIES } from './cache.ts';
import { MiB } from './routes.ts';
import { notamOptionsFromEnv } from './notams/service';

function integer(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}
const port = integer('INFO_PORT', 8787, 1, 65535), host = process.env.INFO_HOST ?? '127.0.0.1';
const origin = process.env.INFO_CORS_ORIGIN;
if (origin && (new URL(origin).origin !== origin || !/^https?:/.test(origin))) throw new Error('INFO_CORS_ORIGIN must be one HTTP(S) origin');
const sourceUrl = process.env.INFO_SOURCE_URL;
if (sourceUrl && (new URL(sourceUrl).href !== sourceUrl || !/^https?:/.test(sourceUrl))) throw new Error('INFO_SOURCE_URL must be an HTTP(S) source archive URL');
const app = await createInfoServer({ directory: resolve(process.env.WEATHER_CACHE_DIR ?? '.cache/weather'),
  notams: await notamOptionsFromEnv(process.env),
  maxBytes: integer('WEATHER_CACHE_MIB', DEFAULT_WEATHER_CACHE_BYTES / MiB, 8, 1_048_576) * MiB,
  maxEntries: integer('WEATHER_CACHE_ENTRIES', DEFAULT_WEATHER_CACHE_ENTRIES, 1, 1_000_000),
  ...(sourceUrl ? { sourceUrl } : {}), ...(origin ? { origin } : {}), ...(process.env.INFO_USER_AGENT ? { userAgent: process.env.INFO_USER_AGENT } : {}),
  log: message => console.error(new Date().toISOString(), message) });
function close() {
  void app.close().catch(error => { console.error(error); process.exitCode = 1; });
}
app.server.on('error', error => { console.error(error); process.exitCode = 1; close(); });
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, close);
app.server.listen(port, host, () => console.log(`Info server listening on http://${host}:${port}`));
