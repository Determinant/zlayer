import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAwcAdvisorySnapshot } from '@zlayer/contracts';
import { normalizeAdvisories } from '../src/layers/weather-awc/source';
import { createInfoServer } from '../tools/info-server/server';
import capture from './fixtures/sigmet-duration-2026-10-17.json';

const hour = 3_600_000;
const normalize = (features = capture.collection.features, at = capture.checkedAt) =>
  normalizeAdvisories('sigmet', [{ type: 'FeatureCollection', features }], at, capture.source);

test('captured three-hour SIGMET periods preserve complete source evidence and retain an explicit duration diagnostic', () => {
  const before = structuredClone(capture.collection), result = normalize();
  assert.ok(isAwcAdvisorySnapshot(result)); assert.equal(result.schemaVersion, 1); assert.equal(result.issues, undefined);
  assert.equal(result.advisories.length, before.features.length);
  for (const [i, advisory] of result.advisories.entries()) {
    const feature = before.features[i]!;
    assert.deepEqual(advisory.sourceProperties, feature.properties);
    assert.deepEqual(JSON.parse(advisory.sourceGeometry ?? JSON.stringify(advisory.geometry)), feature.geometry);
    assert.equal(advisory.validFrom, Date.parse(feature.properties.validTimeFrom));
    assert.equal(advisory.validTo, Date.parse(feature.properties.validTimeTo));
    assert.equal(advisory.classification?.sourceDurationMs, i < 2 ? 3 * hour : undefined);
  }
  assert.deepEqual(capture.collection, before);
});

// Invented adjacent-calendar examples qualify the general period rule, not
// additional observed AWC notices or a change to publisher issuance standards.
const start = Date.parse('2026-12-31T23:00:00Z');
function feature(convective: boolean, hours: number, supplied = true) {
  const end = new Date(start + hours * hour), clock = end.toISOString().slice(11, 16).replace(':', '');
  const printedEnd = convective ? clock : `${String(end.getUTCDate()).padStart(2, '0')}${clock}`;
  return { type: 'Feature', geometry: capture.collection.features[0]!.geometry, properties: {
    icaoId: 'KKCI', airSigmetType: 'SIGMET', seriesId: convective ? '99E' : 'ALFA 1',
    hazard: supplied ? convective ? 'CONVECTIVE' : 'TURB' : null,
    validTimeFrom: new Date(start).toISOString(), validTimeTo: end.toISOString(),
    rawAirSigmet: convective
      ? `WSUS31 KKCI 312300\nMKCE WST 312300\nCONVECTIVE SIGMET 99E\nVALID UNTIL ${printedEnd}Z\nAREA TS.`
      : `WSUS01 KKCI 312300\nKKCI WS 312300\nSIGMET ALFA 1 VALID UNTIL ${printedEnd}\nSEV TURB.`,
  } };
}
const generated = (source: ReturnType<typeof feature>) =>
  normalizeAdvisories('sigmet', [{ type: 'FeatureCollection', features: [source] }], start, capture.source);

test('nominal periods can prove missing categories; atypical periods need supplied categories and exact full source intervals', () => {
  for (const convective of [true, false]) for (const hours of [0.5, 1, 2, 3, 4, 5, 6, 7]) for (const supplied of [true, false]) {
    const nominal = convective ? 2 : 4, source = feature(convective, hours, supplied), result = generated(source);
    const accepted = hours <= nominal || supplied && hours <= 6;
    assert.equal(result.advisories.length, Number(accepted), JSON.stringify({ convective, hours, supplied }));
    assert.equal(result.issues?.length ?? 0, Number(!accepted));
    if (accepted) {
      const advisory = result.advisories[0]!;
      assert.equal(advisory.classification?.sourceDurationMs, hours > nominal ? hours * hour : undefined);
      assert.equal(advisory.hazard, supplied ? source.properties.hazard : convective ? 'CONVECTIVE' : 'UNK');
      assert.equal(advisory.validTo, Date.parse(source.properties.validTimeTo));
    } else assert.equal(result.issues?.[0]?.detail, 'unsupported-bulletin');
  }
});

test('duration evidence cannot hide a changed issuer, category, identifier, interval, calendar or clipped atypical period', () => {
  const mutations: Array<(source: ReturnType<typeof feature>) => void> = [
    source => { source.properties.icaoId = 'KXXX'; },
    source => { source.properties.seriesId = '98E'; },
    source => { source.properties.hazard = 'TURB'; },
    source => { source.properties.validTimeTo = new Date(start + 3 * hour + 60_000).toISOString(); },
    source => { source.properties.validTimeFrom = new Date(start - 60_000).toISOString(); },
    source => { source.properties.validTimeFrom = new Date(start + 60_000).toISOString(); },
    source => { source.properties.validTimeTo = new Date(start + 2 * hour).toISOString(); },
    source => { source.properties.validTimeFrom = '2026-02-30T23:00:00Z'; },
    source => { source.properties.rawAirSigmet += '\nCANCELLED'; },
    source => { source.properties.rawAirSigmet += '\nCONVECTIVE SIGMET 98E\nVALID UNTIL 0200Z\nTS'; },
    source => { source.properties.rawAirSigmet = source.properties.rawAirSigmet.replace('0200Z', '2400Z'); },
  ];
  for (const mutate of mutations) {
    const source = feature(true, 3); mutate(source);
    assert.equal(generated(source).issues?.length, 1, String(mutate));
  }
  const contradiction = feature(true, 3); contradiction.properties.validTimeTo = new Date(start + 4 * hour).toISOString();
  assert.equal(generated(contradiction).issues?.[0]?.detail, 'validity-conflict');
  assert.equal(generated(feature(true, 3, false)).issues?.[0]?.detail, 'unsupported-bulletin');
  for (const patch of [{ sourceDurationMs: 2 * hour }, { sourceDurationMs: 7 * hour }, { sourceDurationMs: '3 hours' },
    { sourceDurationMs: 3 * hour, basis: 'bulletin' }, { sourceDurationMs: 3 * hour, bulletin: 'unsupported' }]) {
    const snapshot = normalize(); Object.assign(snapshot.advisories[0]!.classification!, patch);
    assert.equal(isAwcAdvisorySnapshot(snapshot), false);
  }
});

test('HTTP publication and restart retain duration warnings, while genuine time conflicts still block coverage and recover', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sigmet-source-duration-'));
  let now = capture.checkedAt, conflict = false, requests = 0;
  const options = { directory, now: () => now, startUpdates: false, spacing: 0, fetch: async () => {
    requests++;
    const collection = structuredClone(capture.collection);
    if (conflict) collection.features[0]!.properties.validTimeTo = new Date(Date.parse(collection.features[0]!.properties.validTimeTo) + 60_000).toISOString();
    return Response.json(collection);
  } };
  let app = await createInfoServer(options);
  async function listen() {
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address(); assert.ok(address && typeof address !== 'string');
    return `http://127.0.0.1:${address.port}`;
  }
  async function read(origin: string) {
    const response = await fetch(origin + '/api/weather/advisories/sigmet.json'); assert.equal(response.status, 200);
    return response.json();
  }
  try {
    let origin = await listen();
    const initial = await read(origin); assert.ok(isAwcAdvisorySnapshot(initial)); assert.equal(initial.issues, undefined);
    let health = await (await fetch(origin + '/api/weather/healthz')).json();
    assert.equal(health.advisories.sigmet.interpretation.classification.sourceDurationAnomalies, 2);
    assert.equal(health.readiness.sources['advisory.sigmet'].coverage, 'complete');
    assert.ok(health.readiness.warnings.some((w: { reason: string }) => w.reason === 'source-duration-anomaly'));
    assert.ok(!health.readiness.problems.some((p: { product: string }) => p.product === 'advisory.sigmet'));
    await app.close(); app = await createInfoServer(options); origin = await listen();
    assert.deepEqual(await read(origin), initial); assert.equal(requests, 1, 'restore must not acquire or freshen the source');
    conflict = true; now += 61_000;
    const partial = await read(origin); assert.equal(partial.issues.length, 1); assert.equal(partial.issues[0].detail, 'validity-conflict');
    health = await (await fetch(origin + '/api/weather/healthz')).json();
    assert.ok(health.readiness.problems.some((p: { product: string }) => p.product === 'advisory.sigmet'));
    conflict = false; now += 61_000;
    const recovered = await read(origin); assert.equal(recovered.issues, undefined); assert.equal(recovered.advisories.length, initial.advisories.length);
    assert.equal(requests, 3);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});
