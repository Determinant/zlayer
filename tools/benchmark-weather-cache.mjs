// Serialization/localStorage probe, not an iPhone memory or energy measurement.
// node tools/benchmark-weather-cache.mjs [chromium|webkit]
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
const engineName = process.argv[2] ?? 'chromium', engine = { chromium, webkit }[engineName];
assert(engine);
const captured = JSON.parse(await readFile('test/fixtures/nws/metars-noaa.json', 'utf8'));
const taf = JSON.parse(await readFile('src/layers/metar-taf/validation/2026-09-23-source-comparison/taf-ksfo-amended.json', 'utf8'));
const id = i => `K${i.toString(36).toUpperCase().padStart(3, '0')}`;
// Expand captured report shapes to the existing cache count ceilings. These are
// synthetic station populations, not a captured national cache or worst-case text.
const metars = { type: 'FeatureCollection', features: Array.from({ length: 5000 }, (_, i) => {
  const report = structuredClone(captured.features[i % captured.features.length]);
  report.properties.stationname = id(i); return report;
}) };
const tafs = Array.from({ length: 200 }, (_, i) => ({ icaoId: id(i), issueTime: taf.issuanceTime,
  validTimeFrom: Date.parse('2026-09-23T21:00Z') / 1000, validTimeTo: Date.parse('2026-09-25T00:00Z') / 1000,
  rawTAF: taf.productText, fcsts: [] }));
const server = createServer((_request, response) => response.end('<!doctype html><title>Weather cache probe</title>'));
let browser;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await engine.launch(); const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const results = await page.evaluate(({ metars, tafs }) => {
    const results = [];
    for (const [product, data] of Object.entries({ metars, tafs })) {
      const rounds = [];
      for (let i = -1; i < 10; i++) {
        // Exercise a changed report rather than a browser's identical-write fast path.
        if (product === 'metars') data.features[0].properties.rawdata = `${metars.features[1].properties.rawdata} ${i}`;
        else data[0].rawTAF = `${tafs[1].rawTAF} ${i}`;
        const begin = performance.now(), raw = JSON.stringify(data), serialized = performance.now();
        localStorage.setItem('cache-probe', raw);
        const saved = performance.now();
        if (i >= 0) rounds.push({ stringifyMs: serialized - begin, writeMs: saved - serialized });
      }
      const raw = JSON.stringify(data);
      results.push({ product, utf8Bytes: new TextEncoder().encode(raw).byteLength, utf16Bytes: raw.length * 2, rounds });
      localStorage.removeItem('cache-probe');
    }
    return results;
  }, { metars, tafs });
  const output = { engine: engineName, version: browser.version(), population: 'synthetic, expanded captured report shapes', results };
  await mkdir('tmp/weather-cache-profile', { recursive: true });
  await writeFile(`tmp/weather-cache-profile/${engineName}.json`, JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output));
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
