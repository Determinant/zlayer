import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WeatherCache } from '../tools/info-server/cache';
import { createAdvisoryWarming } from '../tools/info-server/advisories';
import { createUpstream, digest } from '../tools/info-server/upstream';
import { advisoryResource, HttpError, resourceFor } from '../tools/info-server/routes';
import { createProcessing } from '../tools/info-server/processing';
import { createInfoServer } from '../tools/info-server/server';
import { advisorySnapshot, advisorySource, WEATHER_NOW } from './fixtures/awc-advisories';
import classifiedSigmets from './fixtures/sigmet-classification-2026-10-10.json' with { type: 'json' };
import { normalizeAdvisories } from '../src/layers/weather-awc/source';

test('SIGMET classification survives HTTP publication and restart, while real conflicts degrade and recover', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'info-sigmet-classification-'));
  const capture = classifiedSigmets.captures[0]!;
  let now = Date.parse(capture.capturedAt), mode: 'recovered' | 'unsupported' | 'conflict' = 'recovered', reads = 0;
  const options = { directory, spacing: 0, now: () => now, startUpdates: false, fetch: async () => {
    reads++;
    const collection = structuredClone(capture.collection);
    const p = collection.features.find(f => f.properties.seriesId === '6C')!.properties;
    if (mode === 'conflict') p.hazard = 'TURB';
    if (mode === 'unsupported') { p.hazard = 'CONVECTIVE'; p.rawAirSigmet = p.rawAirSigmet.replace('MKCC WST 101655', 'NEW HEADER EXTENSION'); }
    return Response.json(collection);
  } };
  let app = await createInfoServer(options);
  async function listen() {
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address(); assert.ok(address && typeof address === 'object');
    return `http://127.0.0.1:${address.port}`;
  }
  try {
    let origin = await listen();
    const health = async () => (await (await fetch(origin + '/api/weather/healthz')).json()) as any;
    // Seed the pre-upgrade interpretation: the raw 6C record was retained as an
    // issue. Restart must retain that evidence until a real acquisition replaces it.
    const legacy = normalizeAdvisories('sigmet', [capture.collection], now, capture.source);
    for (const advisory of legacy.advisories) delete advisory.classification;
    const raw = capture.collection.features.find(f => f.properties.seriesId === '6C')!;
    const body = Buffer.from(JSON.stringify({ ...legacy, schemaVersion: 2,
      advisories: legacy.advisories.filter(a => a.identifier !== '6C'), issues: [{ id: 'sigmet:issue:legacy-6C',
        issuer: 'KKCI', identifier: '6C', reason: 'invalid-hazard', sourceFeature: JSON.stringify(raw) }] }));
    await app.cache.put(resourceFor('/api/weather/advisories/sigmet.json'),
      { body, checkedAt: now, sha256: digest(body), status: 200, headers: { 'content-type': 'application/json' } });
    await app.close(); app = await createInfoServer(options); origin = await listen();
    assert.equal(reads, 0);
    const legacyHealth = (await health()).advisories.sigmet;
    assert.equal(legacyHealth.error, 'incomplete-advisories');
    assert.equal(legacyHealth.interpretation.classification.legacy, capture.collection.features.length - 1);
    for (const next of ['recovered', 'unsupported', 'conflict', 'recovered'] as const) {
      mode = next; now += 61_000;
      const conflict = mode === 'conflict';
      const response = await fetch(origin + '/api/weather/advisories/sigmet.json');
      assert.equal(response.status, 200);
      const snapshot = await response.json() as any;
      const state = await health();
      assert.equal(snapshot.advisories.length, capture.collection.features.length - Number(conflict));
      assert.equal(snapshot.issues?.length ?? 0, Number(conflict));
      assert.equal(state.advisories.sigmet.checkedAt, snapshot.checkedAt);
      assert.equal(state.advisories.sigmet.error, conflict ? 'incomplete-advisories' : null);
      assert.equal(state.readiness.sources['advisory.sigmet'].coverage, conflict ? 'partial' : 'complete');
      const summary = state.advisories.sigmet.interpretation;
      assert.equal(summary.acceptedRecords, snapshot.advisories.length);
      assert.equal(summary.classification.legacy, 0);
      assert.equal(summary.classification.bulletin, Number(mode === 'recovered'));
      assert.deepEqual(summary.issueDetails, conflict ? { 'category-conflict': 1 } : {});
      assert.deepEqual(summary.issueSamples, conflict ? [{ issuer: 'KKCI', identifier: '6C', reason: 'invalid-hazard', detail: 'category-conflict' }] : []);
      if (!conflict) {
        const advisory = snapshot.advisories.find((a: any) => a.identifier === '6C');
        assert.equal(advisory.hazard, 'CONVECTIVE'); assert.equal(advisory.sourceProperties.hazard, mode === 'unsupported' ? 'CONVECTIVE' : null);
        if (mode === 'unsupported') assert.ok(summary.classification.unsupportedBulletins > 0);
      }
      const readsBeforeRestart: number = reads;
      await app.close(); app = await createInfoServer(options); origin = await listen();
      const restored = await health();
      assert.equal(reads, readsBeforeRestart, 'restoration cannot acquire sources');
      assert.equal(restored.advisories.sigmet.checkedAt, snapshot.checkedAt, 'restart cannot freshen the source');
      assert.equal(restored.advisories.sigmet.error, conflict ? 'incomplete-advisories' : null);
      assert.deepEqual(restored.advisories.sigmet.interpretation, summary, 'restart restores diagnostics from the same committed evidence');
    }
    const damaged = structuredClone(capture.collection);
    for (const feature of damaged.features) Object.assign(feature.properties, { hazard: 0 });
    now += 1_000;
    const partial = normalizeAdvisories('sigmet', [damaged], now, capture.source);
    const put = async (value: unknown) => {
      const body = Buffer.from(JSON.stringify(value));
      await app.cache.put(resourceFor('/api/weather/advisories/sigmet.json'),
        { body, checkedAt: now, sha256: digest(body), status: 200, headers: { 'content-type': 'application/json' } });
    };
    await put(partial);
    const summary = (await health()).advisories.sigmet.interpretation;
    assert.equal(summary.acceptedRecords, 0);
    assert.deepEqual(summary.issueReasons, { 'invalid-hazard': damaged.features.length });
    assert.deepEqual(summary.issueDetails, { 'malformed-hazard': damaged.features.length });
    assert.equal(summary.issueSamples.length, 5, 'health bounds examples rather than echoing source bulletins');
    assert.ok(summary.issueSamples.every((issue: any) => !('sourceFeature' in issue)));
    await put({});
    const invalidHealth = await health(), invalid = invalidHealth.advisories.sigmet;
    assert.equal(invalid.error, 'invalid-source'); assert.equal(invalid.interpretation, null);
    assert.equal(invalidHealth.readiness.sources['advisory.sigmet'].coverage, 'unknown');
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('advisory background failures remain visible, independent, coalesced and recover with original source times', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'info-advisories-')), shutdown = new AbortController();
  let now = 100000, failing = true, calls = 0;
  const logs: string[] = [];
  const cache = new WeatherCache({ directory, now: () => now, maxBytes: 1024 * 1024, load: async resource => {
    calls++;
    if (failing && resource.url.includes('/sigmet.json')) throw new HttpError(502, 'fixture upstream failure');
    const product = resource.url.includes('/cwa') ? 'cwa' : resource.url.includes('/sigmet') ? 'sigmet' : 'gairmet';
    const body = Buffer.from(JSON.stringify({ ...advisorySnapshot(product), checkedAt: now }));
    return { body, sha256: digest(body), checkedAt: now, status: 200, headers: { 'content-type': 'application/json' } };
  } });
  const create = () => createAdvisoryWarming(cache, shutdown.signal, { now: () => now, log: line => logs.push(line) });
  let warming = create();
  try {
    await cache.restore(); warming.refresh(); warming.refresh(); await warming.close();
    assert.equal(calls, 3); assert.equal(warming.status.sigmet!.error, 'upstream-unavailable');
    assert.equal(warming.status.cwa!.ready, true); assert.equal(warming.status.sigmet!.checkedAt, null);
    now += 30000; warming.refresh(); await warming.close();
    assert.equal(logs.length, 1, 'unchanged failure is not logged each round');
    failing = false; now += 30000; warming.refresh(); await warming.close();
    assert.equal(warming.status.sigmet!.error, null); assert.equal(warming.status.sigmet!.checkedAt, now);
    assert.equal(logs.at(-1), 'Advisory sigmet recovered');
    warming = create(); now++; await warming.restore();
    assert.equal(warming.status.sigmet!.checkedAt, now - 1, 'restore cannot freshen saved observations');
    shutdown.abort(); const before = calls; warming.refresh(); await warming.close(); assert.equal(calls, before);
  } finally { shutdown.abort(); await warming.close(); await cache.drain(); await rm(directory, { recursive: true, force: true }); }
});
test('transport and interrupted bodies are classified as upstream failures', async () => {
  for (const stream of [false, true]) {
    const upstream = createUpstream({ spacing: 0, signal: new AbortController().signal, fetch: async () => {
      if (!stream) throw new TypeError('private transport details');
      return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('socket reset')); } }));
    } });
    await assert.rejects(upstream(advisoryResource('sigmet')),
      cause => cause instanceof HttpError && cause.status === 502 && !cause.message.includes('private'));
  }
});

test('partial advisory coverage survives cache restore, diagnoses invalid source data, and recovers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'info-advisory-coverage-')), shutdown = new AbortController();
  let now = WEATHER_NOW, mode: 'partial' | 'invalid' | 'complete' = 'partial';
  const cache = new WeatherCache({ directory, now: () => now, maxBytes: 4 * 1024 * 1024, load: async resource => {
    if (resource.kind === 'prepared') return processing.load(resource);
    const product = resource.url.includes('/cwa') ? 'cwa' : resource.url.includes('sigmet') ? 'sigmet' : 'gairmet';
    const collection = advisorySource(product);
    const input = product === 'gairmet' ? [0, 3, 6, 9, 12].map(hour => advisorySource(product, hour))
      : product === 'cwa' && mode === 'partial' ? { ...collection, features: [...collection.features, null] } : collection;
    const body = Buffer.from(product === 'cwa' && mode === 'invalid' ? '{' : JSON.stringify(input));
    return { body, sha256: digest(body), checkedAt: now, status: 200, headers: { 'content-type': 'application/json' } };
  } });
  const processing = createProcessing(cache, shutdown.signal, () => now);
  const create = () => createAdvisoryWarming(cache, shutdown.signal, { now: () => now });
  let warming = create();
  try {
    await cache.restore(); warming.refresh(); await warming.close();
    assert.equal(warming.status.cwa!.ready, true); assert.equal(warming.status.cwa!.unresolvedRecords, 1);
    assert.equal(warming.status.cwa!.error, 'incomplete-advisories');
    assert.equal(warming.status.sigmet!.error, null); assert.equal(warming.status.gairmet!.error, null);
    warming = create(); await warming.restore();
    assert.equal(warming.status.cwa!.checkedAt, now); assert.equal(warming.status.cwa!.unresolvedRecords, 1);
    mode = 'invalid'; now += 61_000; warming.refresh(); await warming.close();
    assert.equal(warming.status.cwa!.error, 'invalid-source', 'validation identity survives the cache boundary');
    assert.equal(warming.status.cwa!.checkedAt, WEATHER_NOW); assert.equal(warming.status.cwa!.unresolvedRecords, 1);
    mode = 'complete'; now += 61_000; warming.refresh(); await warming.close();
    assert.equal(warming.status.cwa!.unresolvedRecords, 0); assert.equal(warming.status.cwa!.error, null);
    assert.equal(warming.status.cwa!.checkedAt, now);
  } finally { shutdown.abort(); await warming.close(); await processing.close(); await cache.drain(); await rm(directory, { recursive: true, force: true }); }
});

test('HTTP advisory publications and recovery update health without a background refresh', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'info-advisory-http-'));
  let now = WEATHER_NOW, mode: 'complete' | 'partial' | 'invalid' = 'complete', reads = 0;
  const options = { directory, spacing: 0, now: () => now, startUpdates: false,
    fetch: async () => {
      reads++;
      const collection = advisorySource('cwa');
      return mode === 'invalid' ? new Response('{', { headers: { 'content-type': 'application/json' } })
        : Response.json(mode === 'partial' ? { ...collection, features: [...collection.features, null] } : collection);
    } };
  let app = await createInfoServer(options);
  async function listen() {
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address(); assert.ok(address && typeof address === 'object');
    return `http://127.0.0.1:${address.port}`;
  }
  try {
    let origin = await listen();
    const health = async () => (await (await fetch(origin + '/api/weather/healthz')).json()) as any;
    for (const next of ['complete', 'partial', 'invalid', 'complete', 'partial'] as const) {
      mode = next; now += 61_000;
      const response = await fetch(origin + '/api/weather/advisories/cwa.json');
      const snapshot = await response.json() as any;
      const state = await health();
      if (mode === 'invalid') {
        assert.equal(response.status, 502);
        assert.equal(state.advisories.cwa.error, 'upstream-unavailable', 'malformed JSON fails transport validation');
        assert.equal(state.advisories.cwa.ready, false);
      } else {
        assert.equal(response.status, 200);
        const issues = mode === 'partial' ? 1 : 0;
        assert.equal(snapshot.issues?.length ?? 0, issues);
        assert.equal(state.advisories.cwa.checkedAt, snapshot.checkedAt);
        assert.equal(state.advisories.cwa.unresolvedRecords, issues);
        assert.equal(state.advisories.cwa.ready, true);
        assert.equal(state.advisories.cwa.error, issues ? 'incomplete-advisories' : null);
        assert.equal(state.readiness.sources['advisory.cwa'].coverage, issues ? 'partial' : 'complete');
      }
    }
    const before = reads;
    await app.close(); app = await createInfoServer(options); origin = await listen();
    const restored = await health();
    assert.equal(reads, before, 'restoration and health cannot acquire sources');
    assert.equal(restored.advisories.cwa.checkedAt, now);
    assert.equal(restored.advisories.cwa.unresolvedRecords, 1);
    assert.equal(restored.advisories.cwa.error, 'incomplete-advisories');
    assert.equal(restored.advisories.cwa.ready, true);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('late authenticated reads and refresh completions cannot replace newer advisory coverage', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'info-advisory-race-')), shutdown = new AbortController();
  const resource = resourceFor('/api/weather/advisories/cwa.json');
  const payload = (partial = false) => {
    const snapshot = advisorySnapshot('cwa');
    const body = Buffer.from(JSON.stringify(partial ? { ...snapshot, schemaVersion: 2,
      issues: [{ id: 'cwa:issue:test', issuer: 'TEST', identifier: 'TEST', reason: 'invalid-geometry', sourceFeature: 'null' }] } : snapshot));
    return { body, checkedAt: WEATHER_NOW, sha256: digest(body), status: 200, headers: { 'content-type': 'application/json' } };
  };
  const cache = new WeatherCache({ directory, maxBytes: 4 * 1024 * 1024, now: () => WEATHER_NOW, load: async () => payload() });
  const warming = createAdvisoryWarming(cache, shutdown.signal, { now: () => WEATHER_NOW });
  let release = () => {};
  try {
    await cache.restore(); await cache.put(resource, payload());
    let started = () => {};
    const opened = new Promise<void>(resolve => { started = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const originalOpen = cache.open.bind(cache);
    const intercepted = t.mock.method(cache, 'open', async (...args: Parameters<typeof cache.open>) => {
      const saved = await originalOpen(...args); started(); await held; return saved;
    });
    const oldRead = cache.read(resource); await opened;
    await cache.put(resource, payload(true)); release(); await oldRead; intercepted.mock.restore();
    assert.equal(warming.status.cwa!.unresolvedRecords, 1, 'an older open file cannot overwrite the replacement summary');
    assert.equal(warming.status.cwa!.ready, true);

    await cache.put(resource, payload());
    const acquired = new Promise<void>(resolve => { started = resolve; });
    const delayed = new Promise<void>(resolve => { release = resolve; });
    const originalGet = cache.get.bind(cache);
    t.mock.method(cache, 'get', async (...args: Parameters<typeof cache.get>) => {
      const result = await originalGet(...args);
      if (args[0].key === resource.key) { started(); await delayed; }
      return result;
    });
    warming.refresh(); await acquired;
    await cache.put(resource, payload(true)); release(); await warming.close();
    assert.equal(warming.status.cwa!.unresolvedRecords, 1, 'late refresh completion cannot undo a same-time replacement');
    assert.equal(warming.status.cwa!.error, 'incomplete-advisories');
    assert.equal(warming.status.cwa!.ready, true);
  } finally { release(); shutdown.abort(); await warming.close(); await cache.drain(); await rm(directory, { recursive: true, force: true }); }
});

test('invalid persisted advisory output and unsuccessful persistence cannot report ready', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'info-advisory-invalid-')), shutdown = new AbortController();
  let now = WEATHER_NOW;
  const resource = resourceFor('/api/weather/advisories/cwa.json');
  const body = Buffer.from('[]');
  const cache = new WeatherCache({ directory, maxBytes: 128, now: () => now, load: async () => {
    const body = Buffer.from(JSON.stringify({ ...advisorySnapshot('cwa'), checkedAt: now }));
    return { body, checkedAt: now, sha256: digest(body), status: 200, headers: {} };
  } });
  const warming = createAdvisoryWarming(cache, shutdown.signal, { now: () => now });
  try {
    await cache.restore(); await cache.put(resource, { body, checkedAt: now, sha256: digest(body), status: 200, headers: {} });
    assert.equal(warming.status.cwa!.ready, false); assert.equal(warming.status.cwa!.error, 'invalid-source');
    now += 61_000;
    const result = await cache.get(resource);
    assert.ok(result.body.length > 128, 'fixture must exceed the persistence budget');
    assert.equal(warming.status.cwa!.ready, false, 'usable transient data is not a committed publication');
    assert.equal(warming.status.cwa!.checkedAt, WEATHER_NOW);
  } finally { shutdown.abort(); await warming.close(); await cache.drain(); await rm(directory, { recursive: true, force: true }); }
});
