import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRecordingLine, replayAhrs } from '../tools/lib/ahrs-replay';
import { createAhrsRecorder } from '../src/layers/ahrs/recording';
import type { RecordingInfo, RecordingStorage } from '../src/layers/ahrs/recording-storage';
import { createAhrsLayer, type AhrsSnapshot } from '../src/layers/ahrs/layer';
import type { Attitude, ImuSample } from '../src/layers/ahrs/estimator/types';
import type { MagneticCallbacks } from '../src/layers/ahrs/magnetic-sensor';
import { ESTIMATOR_MODEL, N } from '../src/layers/ahrs/estimator/state-layout';

function fixture(t: test.TestContext) {
  const infos = new Map<string, RecordingInfo>(), chunks = new Map<string, Blob[]>();
  let nextId = 0, failure = false;
  const storage: RecordingStorage = {
    async save(info, chunk) {
      if (failure) throw new Error('Storage full');
      if (chunk) { const parts = chunks.get(info.id) ?? []; parts[info.chunks - 1] = chunk; chunks.set(info.id, parts); }
      infos.set(info.id, structuredClone(info));
    },
    async list() { return [...infos.values()]; },
    async *read(info) { yield* chunks.get(info.id)!.slice(0, info.chunks); },
    async remove(id) { infos.delete(id); chunks.delete(id); },
  };
  const recorder = createAhrsRecorder(storage, { now: () => 10, epoch: () => 1_800_000_000_000, id: () => String(++nextId) });
  t.after(() => recorder.stop());
  const events = async () => {
    const parts = [];
    for await (const chunk of storage.read(recorder.getSnapshot().info!)) parts.push(chunk);
    return (await new Blob(parts).text()).trim().split('\n').map(line => JSON.parse(line));
  };
  return { recorder, storage, infos, chunks, events, fail: () => { failure = true; } };
}

test('records ordered immutable events and preserves unaligned uncertainty through JSON export', async t => {
  const { recorder, events } = fixture(t);
  await recorder.start({ timeOrigin: 1_800_000_000_000 });
  const sample = { gyro: [1, 2, 3], headingStd: Infinity };
  recorder.record('imu', 11, sample);
  sample.gyro[0] = 99;
  await recorder.flush();
  recorder.record('gps', 12, { timestamp: 1_800_000_012_000, coordinates: [-122, 37] });
  await recorder.stop();
  const lines = await events();
  assert.deepEqual(lines.map(line => line.type), ['header', 'imu', 'gps', 'end']);
  assert.deepEqual(lines.map(line => line.sequence), [0, 1, 2, 3]);
  assert.deepEqual(lines[1].data, { gyro: [1, 2, 3], headingStd: 'Infinity' });
  assert.equal(recorder.getSnapshot().info!.status, 'complete');
  assert.equal(recorder.getSnapshot().info!.events, 4);
  recorder.record('imu', 13, {});
  assert.equal((await events()).length, 4);
});

test('a storage failure stops capture and leaves the previously committed prefix downloadable', async t => {
  const { recorder, fail, events } = fixture(t);
  await recorder.start({});
  recorder.record('imu', 11, { gyro: [0, 0, 0] });
  await recorder.flush();
  fail();
  recorder.record('imu', 12, { gyro: [1, 0, 0] });
  await recorder.flush();
  assert.equal(recorder.accepting(), false);
  assert.equal(recorder.getSnapshot().phase, 'error');
  assert.match(recorder.getSnapshot().error, /Storage full/);
  assert.deepEqual((await events()).map(line => line.type), ['header', 'imu']);
});

test('stop during initial persistence includes queued samples exactly once', async t => {
  const s = fixture(t), save = s.storage.save;
  let unblock!: () => void;
  const blocked = new Promise<void>(resolve => { unblock = resolve; });
  let first = true;
  s.storage.save = async (info, chunk) => { if (first) { first = false; await blocked; } await save(info, chunk); };
  const starting = s.recorder.start({});
  await Promise.resolve();
  s.recorder.record('imu', 11, {});
  const stopping = s.recorder.stop();
  unblock();
  await Promise.all([starting, stopping]);
  assert.equal(s.recorder.getSnapshot().phase, 'idle');
  assert.deepEqual((await s.events()).map(line => line.type), ['header', 'imu', 'end']);
});

test('concurrent start requests create one recording', async t => {
  const { recorder, infos, events } = fixture(t);
  await Promise.all([recorder.start({}), recorder.start({})]);
  await recorder.stop();
  assert.equal(infos.size, 1);
  assert.deepEqual((await events()).map(line => line.type), ['header', 'end']);
});

test('deleting a completed recording clears its snapshot, metadata and chunks', async t => {
  const { recorder, infos, chunks } = fixture(t);
  await recorder.start({});
  recorder.record('imu', 11, {});
  await recorder.stop();
  const id = recorder.getSnapshot().info!.id;
  await recorder.remove(id);
  assert.equal(infos.has(id), false);
  assert.equal(chunks.has(id), false);
  assert.deepEqual(recorder.getSnapshot(), { phase: 'idle', info: null, error: '' });
});

test('deleting an older recording preserves an active recording and blocks deletion of the active one', async t => {
  const { recorder, infos, chunks } = fixture(t);
  await recorder.start({}); await recorder.stop();
  const old = recorder.getSnapshot().info!.id;
  await recorder.start({});
  const active = recorder.getSnapshot().info!.id;
  await assert.rejects(recorder.remove(active), /Stop recording/);
  await recorder.remove(old);
  assert.equal(recorder.accepting(), true);
  assert.equal(recorder.getSnapshot().info!.id, active);
  assert.equal(infos.has(old), false);
  assert.equal(chunks.has(old), false);
  assert.equal(infos.has(active), true);
  assert.equal(chunks.has(active), true);
});

test('deleting after a capture error waits for an in-flight write before clearing the session', async t => {
  const s = fixture(t), save = s.storage.save;
  let unblock!: () => void;
  const blocked = new Promise<void>(resolve => { unblock = resolve; });
  s.storage.save = async (info, chunk) => { await blocked; await save(info, chunk); };
  const starting = s.recorder.start({});
  const id = s.recorder.getSnapshot().info!.id;
  const invalid: { self?: unknown } = {}; invalid.self = invalid;
  s.recorder.record('imu', 11, invalid);
  assert.equal(s.recorder.getSnapshot().phase, 'error');
  const removing = s.recorder.remove(id);
  assert.equal(s.recorder.getSnapshot().info!.id, id, 'keep the session until persistence settles');
  unblock();
  await Promise.all([starting, removing]);
  assert.equal(s.infos.has(id), false);
  assert.equal(s.chunks.has(id), false);
  assert.equal(s.recorder.getSnapshot().info, null);
});

test('failed deletion retains the saved recording and its recorder snapshot', async t => {
  const s = fixture(t);
  await s.recorder.start({}); await s.recorder.stop();
  const before = s.recorder.getSnapshot();
  s.storage.remove = async () => { throw new Error('Deletion failed'); };
  await assert.rejects(s.recorder.remove(before.info!.id), /Deletion failed/);
  assert.deepEqual(s.recorder.getSnapshot(), before);
  assert.ok((await s.events()).length > 0);
});

test('a pending successful write cannot clear a later capture error', async t => {
  const s = fixture(t), save = s.storage.save;
  let unblock!: () => void;
  const blocked = new Promise<void>(resolve => { unblock = resolve; });
  s.storage.save = async (info, chunk) => { await blocked; await save(info, chunk); };
  const starting = s.recorder.start({});
  const invalid: { self?: unknown } = {};
  invalid.self = invalid;
  s.recorder.record('imu', 11, invalid);
  assert.equal(s.recorder.getSnapshot().phase, 'error');
  unblock();
  await starting;
  assert.match(s.recorder.getSnapshot().error, /circular/i);
  assert.deepEqual((await s.events()).map(line => line.type), ['header']);
});

test('slow storage bounds buffered work and ends capture without affecting the caller', async t => {
  const s = fixture(t), save = s.storage.save;
  await s.recorder.start({});
  let unblock!: () => void;
  const blocked = new Promise<void>(resolve => { unblock = resolve; });
  s.storage.save = async (info, chunk) => { await blocked; await save(info, chunk); };
  for (let i = 0; i < 60; i++) s.recorder.record('imu', i, { padding: 'x'.repeat(64 * 1024) });
  assert.equal(s.recorder.accepting(), false);
  assert.equal(s.recorder.getSnapshot().phase, 'saving');
  unblock();
  await s.recorder.stop();
  assert.equal(s.recorder.getSnapshot().info!.status, 'complete');
  assert.equal(s.recorder.getSnapshot().phase, 'error');
  assert.match(s.recorder.getSnapshot().error, /could not keep up/);
  assert.ok(s.recorder.getSnapshot().info!.bytes < 3 * 1024 * 1024);
  assert.equal((await s.events()).at(-1)!.type, 'end');
});

for (const speed of [null, 0, 50]) test(`layer recording replays calibration, ${speed ?? 'missing'} GPS velocity and every stowed sample`, async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1_800_000_000_000 });
  const s = fixture(t), origin = Date.now(), now = () => (Date.now() - origin) / 1000;
  let sample!: (value: ImuSample) => void;
  let notify!: () => void;
  const layer = createAhrsLayer({
    getSnapshot: () => ({ state: 'tracking', fix: { timestamp: Date.now(), accuracy: 5,
      speed, track: speed === 0 ? null : 90, estimated: false, coordinates: [-122, 37], altitude: 3048, altitudeAccuracy: 5 } }),
    subscribe(listener) { notify = listener; return () => {}; }, acquire: () => () => {}, retry() {},
  }, { now, timeOrigin: origin, recorder: s.recorder,
    motion: (_mount, callback) => { sample = callback; return { start: async () => {}, stop() {} }; } });
  t.after(layer.stop);
  await layer.startRecording();
  await layer.calibrate('flat', 120);
  for (let i = 0; i < (speed === null ? 2000 : 650); i++) {
    t.mock.timers.tick(20);
    sample({ time: now(), gyro: [0, 0, 0], specificForce: [0, 0, -9.80665] });
    if (i % 50 === 0) notify();
    if (i === 600) layer.setVisible(false);
  }
  layer.stop();
  await s.recorder.stop();
  const lines = await s.events();
  const kinds = new Set(lines.map(line => line.type));
  for (const kind of ['header', 'calibrate', 'alignment', 'gps', 'imu', 'innovation', 'state', 'covariance', 'visibility', 'stop', 'end']) assert.ok(kinds.has(kind), kind);
  assert.equal(lines.find(line => line.type === 'calibrate').data.trueHeading, 120);
  assert.equal(lines.find(line => line.type === 'alignment').data.trueHeading, 120);
  assert.equal(lines.some(line => line.type === 'gps' && line.data.forwarded), speed !== null);
  if (speed === null) assert.ok(lines.some(line => line.type === 'innovation' && line.data.source === 'tilt'));
  const ready = lines.filter(line => line.type === 'imu' && line.data.phase === 'ready');
  assert.ok(ready.length > 0);
  assert.ok(ready.every(line => line.data.applied));
  assert.equal(lines.find(line => line.type === 'covariance').data.length, N * N);
  const replay = await replayAhrs(lines.map(line => parseRecordingLine(JSON.stringify(line))));
  assert.equal(replay.segments, 1);
  assert.ok(replay.comparisons > 10);
  assert.equal(replay.maxAttitudeDifference, 0);
  assert.equal(replay.maxCovarianceDifference, 0);
  assert.ok(replay.samples >= 100);
  assert.equal(replay.ended, true);
});

test('replay refuses missing initialization and sequence gaps instead of inventing history', async () => {
  const header = { sequence: 0, type: 'header', time: 0, data: { format: 'zlayer-ahrs', version: 1, context: { estimatorModel: ESTIMATOR_MODEL } } };
  await assert.rejects(() => replayAhrs([header, { sequence: 1, type: 'imu', time: 1,
    data: { phase: 'ready', applied: true, sample: { time: 1, gyro: [0, 0, 0], specificForce: [0, 0, -9.80665] } } }]), /before calibration/);
  await assert.rejects(() => replayAhrs([header, { sequence: 2, type: 'stop', time: 1, data: {} }]), /sequence gap/);
});

test('magnetic fusion records and replays through mount trim, stowing and sensor loss', async t => {
  const s = fixture(t), origin = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: origin });
  const now = () => (Date.now() - origin) / 1000;
  let sample!: (value: ImuSample) => void, magnetic!: MagneticCallbacks, notify = () => {};
  const layer = createAhrsLayer({
    getSnapshot: () => ({ state: 'tracking', fix: { timestamp: Date.now(), accuracy: 3,
      speed: 50, track: 40, estimated: false, coordinates: [-122, 37] } }),
    subscribe(callback) { notify = callback; return () => {}; }, acquire: () => () => {}, retry() {},
  }, { now, timeOrigin: origin, recorder: s.recorder,
    motion: (_mount, callback, _issue, compass) => {
      sample = callback; magnetic = compass!;
      return { start: async () => { magnetic.issue('Waiting for browser compass'); }, stop() {} };
    } });
  t.after(layer.stop);
  await layer.startRecording(); await layer.calibrate('flat');
  const roll = 8 * Math.PI / 180, sr = Math.sin(roll), cr = Math.cos(roll);
  for (let i = 0; i <= 95 * 20; i++) {
    t.mock.timers.tick(50);
    const time = now(), drift = time > 12 ? .15 * Math.PI / 180 : 0;
    sample({ time, gyro: [0, drift * sr, drift * cr], specificForce: [0, -9.80665 * sr, -9.80665 * cr] });
    if (i % 20 === 0) notify();
    if (i % 4 === 0 && time > 12) magnetic.sample({ time, source: 'magnetometer', vector: [25, 10 * cr + 35 * sr, -10 * sr + 35 * cr] });
    if (i === 35 * 20) layer.setVisible(false);
    if (i === 45 * 20) magnetic.issue('Magnetic sensor paused');
  }
  const state = layer.readDisplaySnapshot().attitude!;
  assert.ok(state.magneticFusion.accepted >= 2);
  assert.equal(state.headingReference, 'relative');
  const beforeStop = state.bias;
  layer.stop();
  magnetic.sample({ time: now(), source: 'magnetometer', vector: [90, 0, 0] });
  assert.equal(layer.readDisplaySnapshot().attitude, null, 'late callback cannot restart a stopped session');
  assert.ok(beforeStop[2] > 0);
  await s.recorder.stop();
  const lines = (await s.events()).map(line => parseRecordingLine(JSON.stringify(line)));
  const replayedReasons: string[] = [];
  const replay = await replayAhrs(lines, event => {
    if (event.type === 'state') replayedReasons.push((event.data as Attitude).magneticFusion.reason);
  });
  const recordedReasons = lines.flatMap(line => {
    const state = line.type === 'state' ? (line.data as AhrsSnapshot).attitude : null;
    return state ? [state.magneticFusion.reason] : [];
  });
  assert.ok(recordedReasons.includes('Waiting for browser compass'));
  assert.deepEqual(replayedReasons, recordedReasons);
  assert.ok(replay.statistics.find(stat => stat.source === 'magnetic')!.observations >= 2);
  assert.equal(replay.maxAttitudeDifference, 0); assert.equal(replay.maxCovarianceDifference, 0);
});


for (const estimatorModel of [undefined, 'kinematic-ahrs-v5']) test(`replay explicitly rejects an older estimator model (${estimatorModel ?? 'missing'})`, async () => {
  await assert.rejects(() => replayAhrs([{ sequence: 0, time: 0, type: 'header',
    data: { format: 'zlayer-ahrs', version: 1, context: { estimatorModel } } }]), /Unsupported estimator model/);
});
