import { resolve } from 'node:path';
import { createWeatherServer } from './server.ts';
import { MiB } from './routes.ts';

function integer(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}
const port = integer('WEATHER_PORT', 8787, 1, 65535), host = process.env.WEATHER_HOST ?? '127.0.0.1';
const origin = process.env.WEATHER_CORS_ORIGIN;
if (origin && (new URL(origin).origin !== origin || !/^https?:/.test(origin))) throw new Error('WEATHER_CORS_ORIGIN must be one HTTP(S) origin');
const sourceUrl = process.env.WEATHER_SOURCE_URL;
if (sourceUrl && (new URL(sourceUrl).href !== sourceUrl || !/^https?:/.test(sourceUrl))) throw new Error('WEATHER_SOURCE_URL must be an HTTP(S) source archive URL');
const app = await createWeatherServer({ directory: resolve(process.env.WEATHER_CACHE_DIR ?? '.cache/weather'),
  maxBytes: integer('WEATHER_CACHE_MIB', 4096, 8, 102_400) * MiB,
  ...(sourceUrl ? { sourceUrl } : {}), ...(origin ? { origin } : {}), ...(process.env.WEATHER_USER_AGENT ? { userAgent: process.env.WEATHER_USER_AGENT } : {}),
  log: message => console.error(new Date().toISOString(), message) });
function close() {
  void app.close().catch(error => { console.error(error); process.exitCode = 1; });
}
app.server.on('error', error => { console.error(error); process.exitCode = 1; close(); });
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, close);
app.server.listen(port, host, () => console.log(`Weather gateway listening on http://${host}:${port}`));
