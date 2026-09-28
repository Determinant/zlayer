// Built workspace + verified whole-file storage + deterministic chart packages.
// Usage: node tools/benchmark-rendering.mjs [chromium|webkit|firefox] [desktop|tablet|phone] [rounds]
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cpus, loadavg, release, totalmem } from 'node:os';
import { chromium, firefox, webkit } from 'playwright';

const engineName = process.argv[2] ?? 'chromium', profileName = process.argv[3] ?? 'desktop';
const rounds = Number(process.argv[4] ?? 3);
const outageMode = process.env.ZLAYER_BENCHMARK_OUTAGE ?? 'browser';
assert(['browser', 'origin'].includes(outageMode), 'ZLAYER_BENCHMARK_OUTAGE must be browser or origin');
const engine = { chromium, firefox, webkit }[engineName];
const profile = {
  desktop: { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 },
  tablet: { viewport: { width: 1024, height: 768 }, deviceScaleFactor: 2, hasTouch: true },
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true },
}[profileName];
assert(engine && profile && Number.isInteger(rounds) && rounds >= 1 && rounds <= 20, 'Invalid engine, profile or rounds (1–20)');
const port = Number(process.env.ZLAYER_TEST_PORT ?? 4297), origin = `http://127.0.0.1:${port}`;
const output = resolve(process.env.ZLAYER_BENCHMARK_OUTPUT ?? `tmp/rendering-benchmark/${engineName}-${profileName}-${Date.now()}`);
await mkdir(output, { recursive: true });
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const workingTree = execFileSync('git', ['status', '--short'], { encoding: 'utf8' });
const patch = execFileSync('git', ['diff', '--binary'], { maxBuffer: 32 * 1024 * 1024 });
await writeFile(resolve(output, 'working-tree.patch'), patch);
try { await fetch(origin); throw new Error(`Port ${port} is occupied; choose ZLAYER_TEST_PORT`); }
catch (error) { if (error.message?.includes('occupied')) throw error; }
console.log(`Building isolated rendering benchmark; artifacts: ${output}`);
const server = spawn(process.execPath, ['test/e2e/server.mjs'], {
  env: { ...process.env, ZLAYER_TEST_PORT: String(port), ZLAYER_RENDER_BENCHMARK: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', data => { serverLog += data; }); server.stderr.on('data', data => { serverLog += data; });
let browser;
const results = [];
const host = { cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem(),
  osRelease: release(), startingLoadAverage: loadavg() };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const counts = async () => {
  const response = await fetch(`${origin}/__test/rendering-benchmark`);
  assert(response.ok, 'Benchmark server instrumentation unavailable');
  return response.json();
};
try {
  const deadline = Date.now() + 240_000;
  for (;;) {
    if (server.exitCode !== null) throw new Error(`Fixture server exited: ${serverLog}`);
    try { await counts(); break; } catch { /* Wait for the production build and fixtures. */ }
    if (Date.now() > deadline) throw new Error(`Fixture server startup timed out: ${serverLog}`);
    await sleep(250);
  }
  const fixture = (await counts()).fixture;
  browser = await engine.launch({ headless: engineName !== 'firefox',
    ...(engineName === 'chromium' && process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  for (let round = 0; round < rounds; round++) {
    const context = await browser.newContext(profile);
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem('zlayer-ui:welcome-acknowledged', JSON.stringify({ version: 1, value: true }));
      localStorage.setItem('zlayer-ui:plugins-unloaded', JSON.stringify({ version: 1,
        value: ['terrain', 'obstructions', 'metar', 'weather-awc', 'ownship', 'ahrs'] }));
      localStorage.setItem('zlayers-map-preferences-v1', JSON.stringify({ version: 2, chartBase: 'vfr-sectional',
        terrainEnabled: false, metarEnabled: false, obstructionsEnabled: false, ownshipEnabled: false }));
      localStorage.setItem('zlayers-map-view-v1', JSON.stringify({ version: 1, center: [-120, 39.3], zoom: 7, bearing: 0, pitch: 0 }));
    });
    const cdp = engineName === 'chromium' ? await context.newCDPSession(page) : undefined;
    await cdp?.send('Performance.enable');
    const ready = async () => {
      await page.locator('.app-shell[aria-busy="false"]').waitFor();
      await page.waitForFunction(() => {
        const probe = window.renderingBenchmark;
        return probe && probe.map.loaded() && !probe.map.isMoving() && probe.pendingOpens === 0;
      });
    };
    const measure = async (name, action, { load = false, boundary = false, motion = false, noNetwork = false } = {}) => {
      const before = (await counts()).archives;
      if (!load) await page.evaluate(name => window.renderingBenchmark.begin(name), name);
      let heapPeak = 0, heapSamples = 0, sampling;
      const sample = () => {
        if (!cdp) return Promise.resolve();
        if (sampling) return sampling;
        sampling = cdp.send('Performance.getMetrics').then(({ metrics }) => {
          heapPeak = Math.max(heapPeak, metrics.find(m => m.name === 'JSHeapUsedSize')?.value ?? 0); heapSamples++;
        }).finally(() => { sampling = undefined; });
        return sampling;
      };
      const timer = cdp ? setInterval(() => { void sample().catch(error => errors.push(String(error))); }, 100) : undefined;
      try {
        await action(); await ready();
        if (timer) clearInterval(timer);
        await sample();
        const result = await page.evaluate(() => window.renderingBenchmark.snapshot());
        result.phase = name;
        const after = (await counts()).archives;
        const requests = Object.entries(after).flatMap(([path, count]) => count > (before[path] ?? 0)
          ? [{ path, count: count - (before[path] ?? 0) }] : []);
        assert.deepEqual(errors, [], 'Browser error invalidates the benchmark');
        for (const [stage, metric] of Object.entries(result.stages)) assert.equal(metric.failed, 0, `${stage} failed`);
        if (load) {
          assert(result.readyTiles > 0 && result.chartSettledMs > 0, 'Charts did not reach a rendered idle frame');
          assert(result.stages['package-open']?.count > 0, 'Package loading hook did not run');
          assert(result.navigationUploads['nav-airports'] > 0, 'Navigation upload probe did not run');
        }
        if (motion) {
          assert(result.movingFrameIntervals.count >= 10, 'Camera path did not produce enough rendered frames');
          assert.deepEqual(result.navigationUploads, {}, 'Camera movement resubmitted unchanged navigation data');
        }
        if (boundary) assert(result.boundaryTiles > 0 && result.stages.composition?.count > 0, 'Edition boundary composition was not exercised');
        if (noNetwork) assert.equal(requests.length, 0, 'Warm chart files unexpectedly reached the origin');
        const pixels = await page.evaluate(() => new Promise((resolve, reject) => {
          const map = window.renderingBenchmark.map;
          const timer = setTimeout(() => reject(new Error('Pixel verification frame timed out')), 10_000);
          map.once('render', () => {
            clearTimeout(timer);
            try {
              const canvas = map.getCanvas(), gl = canvas.getContext('webgl2');
              const read = point => {
                const projected = map.project(point), rgba = new Uint8Array(4);
                gl.readPixels(Math.floor(projected.x * canvas.width / canvas.clientWidth),
                  canvas.height - 1 - Math.floor(projected.y * canvas.height / canvas.clientHeight), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
                return [...rgba];
              };
              resolve({ california: read([-120.3, 39.3]), nevada: read([-119.7, 39.4]) });
            } catch (error) { reject(error); }
          });
          map.triggerRepaint();
        }));
        const saved = name.startsWith('saved-') || name === 'offline-reload' || name === 'origin-outage-reload';
        assert(pixels.nevada[2] - pixels.nevada[0] > 20, 'Browsing chart pixels missing or wrong edition');
        assert(saved ? pixels.california[0] - pixels.california[2] > 20 : pixels.california[2] - pixels.california[0] > 20,
          'California chart pixels missing or wrong edition');
        const record = { round, ...result, pixels, originArchiveRequests: requests,
          sampledMainThreadHeap: cdp ? { peakBytes: heapPeak, samples: heapSamples, intervalMs: 100 } : null };
        results.push(record);
        console.log(`${round + 1}/${rounds} ${name}: settled=${result.chartSettledMs?.toFixed(1) ?? 'cached'}ms ` +
          `moving p95=${result.movingFrameIntervals.p95Ms?.toFixed(1) ?? 'n/a'}ms ` +
          `opens=${result.stages['package-open']?.count ?? 0} reopens=${result.packageReopens} origin=${requests.reduce((sum, r) => sum + r.count, 0)}`);
        await page.screenshot({ path: resolve(output, `${round}-${name}.png`) });
      } finally { if (timer) clearInterval(timer); await sampling; }
    };
    const travel = () => page.evaluate(async () => {
      const map = window.renderingBenchmark.map;
      const views = [
        { center: [-119.3, 39.3], zoom: 7.8, bearing: 0 },
        { center: [-118.8, 39.8], zoom: 8.6, bearing: 20 },
        { center: [-120.7, 39.1], zoom: 8.2, bearing: -15 },
        { center: [-120, 39.3], zoom: 7, bearing: 0 },
      ];
      for (const view of views) await new Promise((resolve, reject) => {
        const done = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => { map.off('idle', done); reject(new Error('Camera failed to settle')); }, 30_000);
        map.once('idle', done); map.easeTo({ ...view, duration: 1000, essential: true });
      });
    });
    try {
      await measure('cold-load', () => page.goto(origin), { load: true });
      await measure('cached-reload', () => page.reload(), { load: true, noNetwork: true });
      await measure('pan-zoom', travel, { motion: true });
      await measure('pan-zoom-revisit', travel, { motion: true, noNetwork: true });
      // Commit an older California edition through the actual download workflow.
      await page.getByLabel('Settings and offline downloads').click();
      await page.getByLabel('FAA data cycle').selectOption('2026-08-06');
      await page.getByLabel('Find a state or territory').fill('California');
      await page.locator('.region-cycle').filter({ hasText: /Aug 6/ }).waitFor();
      await page.locator('.region-row').getByRole('button', { name: 'Download', exact: true }).click();
      await page.locator('.download-card .offline-tag').filter({ hasText: /^Saved$/ }).waitFor();
      await page.getByLabel('FAA data cycle').selectOption('latest');
      await page.getByLabel('Close settings').click(); await ready();
      await measure('saved-boundary-reload', () => page.reload(), { load: true, boundary: true, noNetwork: true });
      await measure('saved-boundary-pan', travel, { motion: true, boundary: true });
      if (outageMode === 'browser') await context.setOffline(true);
      else assert((await fetch(`${origin}/__test/disconnect`, { method: 'POST' })).ok);
      await measure(outageMode === 'browser' ? 'offline-reload' : 'origin-outage-reload',
        () => page.reload(), { load: true, boundary: true, noNetwork: true });
    } catch (error) {
      await page.screenshot({ path: resolve(output, `${round}-failure.png`) }).catch(() => {});
      await writeFile(resolve(output, `${round}-failure-ui.txt`), await page.locator('body').innerText().catch(() => 'Page unavailable'));
      throw error;
    } finally {
      await cdp?.detach(); await context.close();
      if (outageMode === 'origin') await fetch(`${origin}/__test/rendering-benchmark-connect`, { method: 'POST' });
    }
  }
  await writeFile(resolve(output, 'results.json'), JSON.stringify({ schemaVersion: 1, recordedAt: new Date().toISOString(),
    revision, workingTree, engine: engineName, browserVersion: browser.version(), profile: { name: profileName, ...profile },
    node: process.version, platform: process.platform, architecture: process.arch,
    host: { ...host, endingLoadAverage: loadavg() }, notes: process.env.ZLAYER_BENCHMARK_NOTE ?? '', outageMode, rounds, fixture,
    limitations: ['Synthetic linework and small navigation fixtures; no weather, terrain or PDF workloads.',
      'Chart settled time is navigation-to-first-map-idle after nonempty chart delivery, not first visible pixel.',
      'Frame intervals are main-thread MapLibre render events during motion, not GPU presentation or physical input latency.',
      'Stage times are inclusive and overlap; never add them together.',
      'Memory counts compressed resident tile payloads; sampled Chromium main-thread JS heap excludes workers and GPU.',
      'Instrumentation, local origin and software rendering differ from physical devices.'], results }, null, 2));
  console.log(`Saved ${results.length} validated measurements to ${output}/results.json`);
} catch (error) {
  await writeFile(resolve(output, 'failure.json'), JSON.stringify({ revision, workingTree, engine: engineName,
    browserVersion: browser?.version(), profile: profileName, outageMode, host,
    notes: process.env.ZLAYER_BENCHMARK_NOTE ?? '', message: String(error), stack: error.stack,
    completedPhases: results.length }, null, 2));
  throw error;
} finally {
  await browser?.close();
  if (server.exitCode === null) await new Promise(resolve => {
    const timer = setTimeout(() => server.kill('SIGKILL'), 10_000);
    server.once('exit', () => { clearTimeout(timer); resolve(); });
    server.kill('SIGTERM');
  });
  await writeFile(resolve(output, 'server.log'), serverLog);
  // Keep partial data if a behavioral guard fails; never label it a complete run.
  await writeFile(resolve(output, 'partial-results.json'), JSON.stringify(results, null, 2));
}
