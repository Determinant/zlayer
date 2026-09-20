import assert from 'node:assert/strict';
import test from 'node:test';
import { RegionDownloads, downloadBytes, type DownloadBackend, type DownloadPlan, type OfflineFile } from '../src/offline/downloads';
import { retainCachedProducts } from '../src/workspace/catalog/saved-catalog';
import { resource as routeHistory } from './helpers/route-history';
import type { ChartCatalog } from '../src/workspace/catalog/catalog';
import { activatedPlan, planMetadata, stagedPlan } from '../src/offline/region-selection';
import { InvalidDataError, ResourceError } from '../src/core/data/errors';

const files: Extract<OfflineFile, { kind: 'chart' | 'pdf' }>[] = Array.from({ length: 5 }, (_, i) => ({
  url: `https://charts.test/${i}.mbtiles`, byteLength: (i + 1) * 100, sha256: 'a'.repeat(64), kind: 'chart',
}));
const plan: DownloadPlan = { id: 'west', regionId: 'west', title: 'West', revision: '2026-09-03', files,
  references: [{ id: 'airways', title: 'Airways', url: 'https://charts.test/nav.json', count: 1, sourceCount: 1 }] };

function fixture() {
  const saved = new Map<string, DownloadPlan>();
  const cached = new Set<string>();
  const requests: string[] = [];
  let references = false;
  const backend: DownloadBackend = {
    list: async () => [...saved.values()], save: async plan => { saved.set(plan.id, plan); },
    forget: async id => { saved.delete(id); }, cachedBytes: async file => cached.has(file.url) ? file.byteLength : undefined,
    referencesReady: async () => references, prepare: async () => { references = true; },
    download: async file => { requests.push(file.url); cached.add(file.url); },
    remove: async file => { cached.delete(file.url); }, exclusive: work => work(),
  };
  return { saved, cached, requests, backend, manager: new RegionDownloads(backend) };
}

test('region downloads persist intent, use cached whole files, and restore after restart', async () => {
  const f = fixture();
  f.cached.add(files[0]!.url);
  await f.manager.start(plan);
  assert.deepEqual(f.saved.get(plan.id), plan);
  assert.deepEqual(new Set(f.requests), new Set(files.slice(1).map(file => file.url)));
  assert.equal(f.manager.snapshot()[0]!.state, 'complete');
  assert.equal(f.manager.snapshot()[0]!.completedBytes, downloadBytes(plan));
  const reopened = new RegionDownloads(f.backend);
  await reopened.restore();
  assert.equal(reopened.snapshot()[0]!.state, 'complete');
  f.cached.delete(files[0]!.url); // Browser eviction invalidates the completeness promise.
  await reopened.restore();
  assert.equal(reopened.snapshot()[0]!.state, 'paused');
  await reopened.start(plan);
  assert.equal(f.requests.at(-1), files[0]!.url);
});

test('captured reference identities are staged before transfer and used for verification and activation', async () => {
  const f = fixture();
  const sealed = { ...plan, references: [{ ...plan.references[0]!, jsonSha256: 'b'.repeat(64) }] };
  f.backend.prepare = async () => sealed;
  f.backend.referencesReady = async value => value === sealed;
  const transfer = f.backend.download;
  f.backend.download = async file => {
    assert.equal(f.saved.get(plan.id), sealed);
    await transfer(file);
  };
  f.backend.complete = async value => { assert.equal(value, sealed); return activatedPlan(value); };
  await f.manager.start(plan);
  assert.equal(f.manager.snapshot()[0]!.state, 'complete');
  assert.deepEqual(f.manager.snapshot()[0]!.references, sealed.references);
});

test('a fully transferred but unactivated snapshot remains resumable until its commit succeeds', async () => {
  const f = fixture();
  const staged = { ...plan, snapshotId: 'a'.repeat(64) };
  f.saved.set(staged.id, staged);
  files.forEach(file => f.cached.add(file.url));
  f.backend.referencesReady = async () => true;
  f.backend.complete = async value => {
    const active = activatedPlan(value);
    f.saved.set(value.id, active);
    return active;
  };
  await f.manager.restore();
  assert.equal(f.manager.snapshot()[0]!.state, 'paused');
  assert.equal(f.manager.snapshot()[0]!.completedFiles, files.length);
  await f.manager.start(f.manager.snapshot()[0]!);
  assert.equal(f.manager.snapshot()[0]!.state, 'complete');
  assert.ok(f.manager.snapshot()[0]!.completedAt);
  assert.deepEqual(f.requests, [], 'resuming commits the existing bytes');
  await f.manager.restore();
  assert.equal(f.manager.snapshot()[0]!.state, 'complete');
});

test('staging retains only the active selection and persists no transient download fields', () => {
  const active = activatedPlan({ ...plan, snapshotId: 'a'.repeat(64) });
  const pending = stagedPlan({ ...plan, snapshotId: 'b'.repeat(64) }, active);
  const replacement = stagedPlan({ ...plan, snapshotId: 'c'.repeat(64) }, pending);
  assert.deepEqual(replacement.previous, active);
  assert.deepEqual(planMetadata({ ...plan, state: 'error', error: 'offline', completedFiles: 4, completedBytes: 200 } as DownloadPlan), plan);
});

test('failed files can be retried without downloading successful files again', async () => {
  const f = fixture();
  const download = f.backend.download;
  f.backend.download = async file => {
    if (file === files[1]) throw new Error('Network interrupted');
    await download(file);
  };
  await f.manager.start(plan);
  assert.equal(f.manager.snapshot()[0]!.state, 'error');
  assert.match(f.manager.snapshot()[0]!.error!, /Network interrupted/);
  const alreadySaved = new Set(f.requests);
  f.backend.download = download;
  await f.manager.start(plan);
  assert.equal(f.manager.snapshot()[0]!.state, 'complete');
  for (const url of alreadySaved) assert.equal(f.requests.filter(request => request === url).length, 1);
});

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

for (const kind of ['chart', 'pdf', 'faa-pdf'] as const) {
  test(`temporary ${kind} failures recover automatically without restarting saved files`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture();
    const file: OfflineFile = kind === 'faa-pdf' ? { kind, url: 'https://charts.test/plate.pdf' }
      : { ...files[0]!, kind };
    const region = { ...plan, files: [file, ...files.slice(1)] };
    f.backend.cachedBytes = async file => f.cached.has(file.url) ? file.byteLength ?? 789 : undefined;
    const download = f.backend.download;
    let attempts = 0;
    f.backend.download = async value => {
      if (value === file && ++attempts <= 2) throw attempts === 1
        ? new TypeError('Failed to fetch') : new DOMException('Timed out', 'TimeoutError');
      await download(value);
    };
    const running = f.manager.start(region);
    await flush();
    assert.equal(attempts, 1);
    assert.equal(f.manager.snapshot()[0]!.state, 'downloading');
    t.mock.timers.tick(999); await flush();
    assert.equal(attempts, 1, 'do not immediately hammer a failing server');
    t.mock.timers.tick(1); await flush();
    assert.equal(attempts, 2);
    t.mock.timers.tick(2_000);
    await running;
    assert.equal(f.manager.snapshot()[0]!.state, 'complete');
    assert.equal(f.manager.snapshot()[0]!.completedFiles, region.files.length);
    assert.equal(new Set(f.requests).size, f.requests.length);
    assert.equal(attempts, 3);
  });
}

test('persistent network failures stop after four attempts and manual retry keeps saved files', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const download = f.backend.download;
  let attempts = 0;
  f.backend.download = async file => {
    if (file === files[0]) { attempts++; throw new ResourceError('request', 'Server unavailable'); }
    await download(file);
  };
  const running = f.manager.start(plan);
  for (const delay of [1_000, 2_000, 4_000]) { await flush(); t.mock.timers.tick(delay); }
  await running;
  assert.equal(attempts, 4);
  assert.equal(f.manager.snapshot()[0]!.state, 'error');
  assert.equal(f.manager.snapshot()[0]!.completedFiles, files.length - 1);
  f.backend.download = download;
  await f.manager.start(f.manager.snapshot()[0]!);
  assert.equal(f.manager.snapshot()[0]!.state, 'complete');
  assert.equal(f.requests.length, files.length);
});

test('pause cancels retry backoff immediately and does not schedule late transfers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  let attempts = 0;
  f.backend.download = async () => { attempts++; throw new TypeError('Failed to fetch'); };
  const running = f.manager.start(plan);
  await flush();
  f.manager.pause(plan.id);
  await running;
  assert.equal(f.manager.snapshot()[0]!.state, 'paused');
  t.mock.timers.tick(60_000); await flush();
  assert.equal(attempts, 3, 'only the three initially active transfers ran');
  await f.manager.remove(plan.id);
  assert.equal(f.manager.snapshot().length, 0, 'pause releases the operation lock');
});

test('a timed-out transfer that saved its file is counted once and not fetched again', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const download = f.backend.download;
  f.backend.download = async file => {
    await download(file);
    if (file === files[0]) throw new DOMException('Timed out', 'TimeoutError');
  };
  const running = f.manager.start(plan);
  await flush(); t.mock.timers.tick(1_000);
  await running;
  assert.equal(f.manager.snapshot()[0]!.state, 'complete');
  assert.equal(f.manager.snapshot()[0]!.completedBytes, downloadBytes(plan));
  assert.equal(f.requests.length, files.length);
});

for (const error of [new DOMException('full', 'QuotaExceededError'), new DOMException('denied', 'SecurityError'),
  new DOMException('unreadable', 'NotReadableError'), new InvalidDataError('hash mismatch'), new ResourceError('http', '404')]) {
  test(`${error.name}: ${error.message} is reported without automatic download retries`, async () => {
    const f = fixture();
    let attempts = 0;
    f.backend.download = async () => { attempts++; throw error; };
    await f.manager.start({ ...plan, files: files.slice(0, 1) });
    assert.equal(attempts, 1);
    assert.equal(f.manager.snapshot()[0]!.state, 'error');
    assert.equal(f.manager.snapshot()[0]!.error, error.message);
  });
}

test('individual-only PDFs are required, measured from durable cache receipts, and reused on retry/reload', async () => {
  const f = fixture();
  const individual: OfflineFile = { kind: 'faa-pdf', url: 'https://aeronav.faa.gov/d-tpp/2609/HIGH.PDF?v=edition' };
  const region = { ...plan, files: [...files, individual] };
  f.backend.cachedBytes = async file => f.cached.has(file.url) ? file.byteLength ?? 789 : undefined;
  const download = f.backend.download;
  f.backend.download = async file => {
    if (file.kind === 'faa-pdf') throw new Error('FAA proxy unavailable');
    await download(file);
  };
  await f.manager.start(region);
  assert.equal(f.manager.snapshot()[0]!.state, 'error', 'hosted books alone cannot satisfy an all-plates download');
  f.backend.download = download;
  await f.manager.start(region);
  assert.equal(f.manager.snapshot()[0]!.state, 'complete');
  assert.equal(f.manager.snapshot()[0]!.completedBytes, downloadBytes(plan) + 789);
  assert.equal(f.requests.length, files.length + 1, 'retry fetches only the missing individual PDF');
  await f.manager.restore();
  assert.equal(f.manager.snapshot()[0]!.completedBytes, downloadBytes(plan) + 789);
  await f.manager.start(region);
  assert.equal(f.requests.length, files.length + 1, 'already cached PDFs are not downloaded again');
});

test('large PDF books are transferred one at a time after chart files', async () => {
  const f = fixture();
  const books: OfflineFile[] = files.map(file => ({ ...file, url: file.url.replace('.mbtiles', '.pdf'), kind: 'pdf' }));
  let active = 0, peak = 0;
  f.backend.download = async file => {
    if (file.kind === 'pdf') {
      assert.ok(files.every(chart => f.cached.has(chart.url)));
      peak = Math.max(peak, ++active);
      await Promise.resolve(); // A concurrent transfer would enter before this one finishes.
      active--;
    }
    f.cached.add(file.url);
  };
  await f.manager.start({ ...plan, files: [...files, ...books] });
  assert.equal(peak, 1);
  assert.equal(f.manager.snapshot()[0]!.completedFiles, 10);
  assert.equal(f.manager.snapshot()[0]!.state, 'complete');
});

test('pause finishes active files and prevents scheduling the rest', async () => {
  const f = fixture();
  const started = deferred();
  const release = deferred();
  f.backend.download = async file => {
    f.requests.push(file.url);
    started.resolve();
    await release.promise;
    f.cached.add(file.url);
  };
  const running = f.manager.start(plan);
  await started.promise;
  await assert.rejects(f.manager.start({ ...plan, id: 'east' }), /Pause/);
  f.manager.pause(plan.id);
  assert.equal(f.manager.snapshot()[0]!.state, 'pausing');
  release.resolve();
  await running;
  assert.equal(f.requests.length, 3);
  assert.equal(f.manager.snapshot()[0]!.state, 'paused');
  assert.equal(f.manager.snapshot()[0]!.completedFiles, 3);
  assert.equal(f.manager.snapshot()[0]!.completedBytes, files.slice(0, 3).reduce((sum, file) => sum + file.byteLength, 0));
});

for (const stage of ['cachedBytes', 'prepare', 'referencesReady'] as const) {
  test(`pause releases a stalled ${stage} check and resume ignores its late result`, async () => {
    const f = fixture();
    const entered = deferred(), release = deferred();
    const original = f.backend[stage];
    let preparations = 0;
    let prepareSignal: AbortSignal | undefined;
    if (stage === 'cachedBytes') f.backend.cachedBytes = async () => {
      entered.resolve(); await release.promise; return undefined;
    };
    if (stage === 'prepare') f.backend.prepare = async (_plan, signal) => {
      prepareSignal = signal;
      preparations++;
      entered.resolve(); await release.promise;
      return { ...plan, revision: 'stale' };
    };
    if (stage === 'referencesReady') f.backend.referencesReady = async () => {
      entered.resolve(); await release.promise; return true;
    };
    const running = f.manager.start(plan);
    await entered.promise;
    assert.equal(f.manager.snapshot()[0]!.state,
      stage === 'prepare' ? 'preparing' : stage === 'referencesReady' ? 'finalizing' : 'verifying');
    f.manager.pause(plan.id);
    await running;
    assert.equal(f.manager.snapshot()[0]!.state, 'paused');
    if (stage === 'prepare') assert.equal(prepareSignal?.aborted, true);
    if (stage !== 'referencesReady') assert.equal(f.requests.length, 0);
    Object.assign(f.backend, { [stage]: original });
    await f.manager.start(f.manager.snapshot()[0]!);
    const completed = f.manager.snapshot()[0]!;
    assert.equal(completed.state, 'complete');
    release.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.manager.snapshot()[0], completed, 'cancelled checks cannot overwrite the resumed job');
    assert.equal(f.saved.get(plan.id)!.revision, plan.revision);
    assert.equal(preparations, stage === 'prepare' ? 1 : 0);
  });
}

test('pause during a transfer cache lookup schedules no download and skips final verification', async () => {
  const f = fixture();
  const entered = deferred(), release = deferred();
  let transferring = false, reads = 0, verifications = 0;
  f.backend.prepare = async () => { transferring = true; };
  f.backend.cachedBytes = async () => {
    reads++;
    if (transferring) { entered.resolve(); await release.promise; }
    return undefined;
  };
  f.backend.referencesReady = async () => { verifications++; return true; };
  const running = f.manager.start(plan);
  await entered.promise;
  f.manager.pause(plan.id);
  await running;
  assert.equal(f.manager.snapshot()[0]!.state, 'paused');
  const pausedReads = reads;
  release.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, pausedReads);
  assert.equal(verifications, 0);
  assert.deepEqual(f.requests, []);
});

test('verify reports cached progress, checks references only once, and clears a prior error', async () => {
  const f = fixture();
  files.forEach(file => f.cached.add(file.url));
  let checks = 0;
  f.backend.referencesReady = async () => { checks++; return true; };
  const counts: number[] = [];
  f.manager.subscribe(() => {
    const job = f.manager.snapshot()[0];
    if (job?.state === 'verifying') counts.push(job.completedFiles);
  });
  await f.manager.start({ ...plan, error: 'Previous failure', state: 'error' } as DownloadPlan);
  assert.equal(checks, 1);
  assert.ok(counts.includes(1));
  assert.ok(counts.includes(files.length));
  assert.equal(f.manager.snapshot()[0]!.error, undefined);
  assert.equal(f.manager.snapshot()[0]!.state, 'complete');
  assert.deepEqual(f.requests, []);
});

test('the final check reports checked files separately from downloaded files and commits only after references', async () => {
  const f = fixture();
  const entered = deferred(), release = deferred();
  const counts: number[] = [];
  let committed = false;
  f.backend.referencesReady = async () => { entered.resolve(); await release.promise; return true; };
  f.backend.complete = async value => { committed = true; return activatedPlan(value); };
  f.manager.subscribe(() => {
    const job = f.manager.snapshot()[0];
    if (job?.state === 'finalizing') {
      counts.push(job.checkedFiles!);
      assert.equal(job.completedFiles, files.length, 'checking does not reset download progress');
    }
  });
  const running = f.manager.start(plan);
  await entered.promise;
  assert.equal(f.manager.snapshot()[0]!.state, 'finalizing');
  assert.deepEqual(counts, [0, 1, 2, 3, 4, 5]);
  assert.equal(committed, false);
  release.resolve();
  await running;
  assert.equal(committed, true);
  assert.equal(f.manager.snapshot()[0]!.state, 'complete');
});

for (const missing of ['file', 'references'] as const) {
  test(`a failed final ${missing} check explains the failure and retries without discarding saved files`, async () => {
    const f = fixture();
    const download = f.backend.download;
    let committed = false;
    f.backend.complete = async value => { committed = true; return activatedPlan(value); };
    if (missing === 'file') f.backend.download = async file => {
      await download(file);
      if (file === files.at(-1)) f.cached.delete(files[0]!.url);
    };
    else f.backend.referencesReady = async () => false;
    await f.manager.start(plan);
    assert.equal(f.manager.snapshot()[0]!.state, 'error');
    assert.match(f.manager.snapshot()[0]!.error!, missing === 'file' ? /files are missing/ : /offline data could not be confirmed/);
    assert.equal(committed, false);
    f.backend.download = download;
    f.backend.referencesReady = async () => true;
    const before = f.requests.length;
    await f.manager.start(f.manager.snapshot()[0]!);
    assert.equal(f.manager.snapshot()[0]!.state, 'complete');
    assert.equal(f.requests.length - before, missing === 'file' ? 1 : 0);
    assert.equal('checkedFiles' in f.saved.get(plan.id)!, false, 'inspection progress is never persisted');
  });
}

test('cache changes between the first check and transfer cannot inflate or hide saved progress', async () => {
  const f = fixture();
  f.cached.add(files[0]!.url);
  const prepare = f.backend.prepare;
  f.backend.prepare = async (value, signal) => {
    await prepare(value, signal);
    f.cached.delete(files[0]!.url);
    f.cached.add(files[1]!.url);
  };
  f.manager.subscribe(() => {
    const job = f.manager.snapshot()[0]!;
    assert.ok(job.completedFiles <= files.length);
    assert.ok(job.completedBytes <= downloadBytes(plan));
    if (job.state === 'finalizing') {
      assert.equal(job.completedFiles, files.length);
      assert.equal(job.completedBytes, downloadBytes(plan));
    }
  });
  await f.manager.start(plan);
  assert.equal(f.manager.snapshot()[0]!.state, 'complete');
  assert.equal(f.requests.includes(files[1]!.url), false);
});

test('a failed saved-region check keeps every selection visible and other regions usable', async () => {
  const f = fixture();
  const neighbor = { ...plan, id: 'neighbor', files: files.slice(1) };
  f.saved.set(plan.id, plan);
  f.saved.set(neighbor.id, neighbor);
  files.forEach(file => f.cached.add(file.url));
  f.backend.referencesReady = async () => true;
  const read = f.backend.cachedBytes;
  f.backend.cachedBytes = async file => {
    if (file === files[0]) throw new Error('Cache temporarily unavailable');
    return read(file);
  };
  await f.manager.restore();
  assert.equal(f.manager.snapshot().length, 2);
  assert.equal(f.manager.snapshot()[0]!.state, 'error');
  assert.match(f.manager.snapshot()[0]!.error!, /Could not check saved data/);
  assert.equal(f.manager.snapshot()[1]!.state, 'complete');
  assert.equal(f.saved.size, 2);
  f.backend.cachedBytes = read;
  await f.manager.restore();
  assert.deepEqual(f.manager.snapshot().map(job => job.state), ['complete', 'complete']);
});

test('pause during activation finishes the commit and keeps the saved status', async () => {
  const f = fixture();
  const entered = deferred(), release = deferred();
  f.backend.complete = async value => {
    entered.resolve(); await release.promise; return activatedPlan(value);
  };
  const running = f.manager.start(plan);
  await entered.promise;
  f.manager.pause(plan.id);
  release.resolve();
  await running;
  assert.equal(f.manager.snapshot()[0]!.state, 'complete');
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('failed verification retires outstanding cache reads before they can overwrite the job or its retry', async () => {
  for (const retry of [false, true]) {
    const f = fixture();
    const release = deferred();
    const cachedBytes = f.backend.cachedBytes;
    let reads = 0;
    f.backend.cachedBytes = async file => {
      reads++;
      if (file === files[0]) throw new Error('Cache temporarily unavailable');
      await release.promise;
      return file.byteLength;
    };
    await f.manager.start(plan);
    assert.equal(f.manager.snapshot()[0]!.state, 'error');
    assert.match(f.manager.snapshot()[0]!.error!, /Cache temporarily unavailable/);
    const failedReads = reads;
    if (retry) {
      f.backend.cachedBytes = cachedBytes;
      await f.manager.start(plan);
      assert.equal(f.manager.snapshot()[0]!.state, 'complete');
    }
    const settled = f.manager.snapshot()[0];
    release.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.manager.snapshot()[0], settled, 'late reads must not republish verification progress');
    assert.equal(reads, failedReads, 'a failed inspection must not schedule more reads');
  }
});

test('completion requires durable bytes and navigation, not a successful HTTP response alone', async () => {
  const f = fixture();
  f.backend.download = async () => {};
  await f.manager.start(plan);
  assert.equal(f.manager.snapshot()[0]!.state, 'error');
  assert.match(f.manager.snapshot()[0]!.error!, /not saved/);
  for (const file of files) f.cached.add(file.url);
  f.backend.referencesReady = async () => false;
  await f.manager.restore();
  assert.equal(f.manager.snapshot()[0]!.state, 'paused');
});

test('shared references are checked once per restore, but readiness never survives the next check', async () => {
  const f = fixture();
  for (const file of files) f.cached.add(file.url);
  f.saved.set(plan.id, plan);
  f.saved.set('neighbor', { ...plan, id: 'neighbor' });
  let checks = 0, ready = true;
  f.backend.referencesReady = async () => { checks++; return ready; };
  await f.manager.restore();
  assert.equal(checks, 1);
  assert.deepEqual(f.manager.snapshot().map(job => job.state), ['complete', 'complete']);
  ready = false;
  await f.manager.restore();
  assert.equal(checks, 2);
  assert.deepEqual(f.manager.snapshot().map(job => job.state), ['paused', 'paused']);
});

test('shared URLs with different reference expectations are verified independently', async () => {
  const f = fixture();
  for (const file of files) f.cached.add(file.url);
  f.saved.set(plan.id, plan);
  f.saved.set('changed', { ...plan, id: 'changed', references: [
    { id: 'airways', title: 'Airways', url: plan.references[0]!.url, count: 2, sourceCount: 2 },
  ] });
  let checks = 0;
  f.backend.referencesReady = async selection => { checks++; return selection.id === plan.id; };
  await f.manager.restore();
  assert.equal(checks, 2);
  assert.deepEqual(f.manager.snapshot().map(job => job.state), ['complete', 'paused']);
});

test('removal preserves overlapping regions, including selections made in another window', async () => {
  const f = fixture();
  await f.manager.start(plan);
  f.saved.set('neighbor', { ...plan, id: 'neighbor', files: files.slice(0, 2) });
  await f.manager.remove('west');
  assert.deepEqual(f.cached, new Set(files.slice(0, 2).map(file => file.url)));
  assert.equal(f.saved.has('west'), false);
  assert.equal(f.manager.snapshot().length, 0);
});

test('failed removal releases the queue and can be retried without losing other regions', async () => {
  const f = fixture();
  await f.manager.start(plan);
  f.saved.set('neighbor', { ...plan, id: 'neighbor', files: files.slice(0, 1) });
  const remove = f.backend.remove;
  f.backend.remove = async file => {
    if (file === files[2]) throw new DOMException('unreadable', 'NotReadableError');
    await remove(file);
  };
  await assert.rejects(f.manager.remove(plan.id), { name: 'NotReadableError' });
  assert.ok(f.saved.has(plan.id));
  assert.ok(f.cached.has(files[0]!.url));
  f.backend.remove = remove;
  await f.manager.remove(plan.id);
  assert.equal(f.saved.has(plan.id), false);
  assert.deepEqual(f.cached, new Set([files[0]!.url]));
  await f.manager.start(plan);
  assert.equal(f.manager.snapshot()[0]!.state, 'complete');
});

test('quota failure and multi-window contention are visible and never marked complete', async () => {
  for (const stage of ['save', 'exclusive'] as const) {
    const f = fixture();
    f.backend[stage] = async () => { throw new Error(stage === 'save' ? 'Storage full' : 'Another window is downloading'); };
    await f.manager.start(plan);
    assert.equal(f.manager.snapshot()[0]!.state, 'error');
    assert.equal(f.requests.length, 0);
  }
});

test('catalog refresh retains cached products only within the selected cycle', () => {
  const cached: ChartCatalog = { schemaVersion: 1, revision: '2026-09-03', generatedAt: '2026-09-03T00:00:00Z',
    routeHistory,
    preferredRoutes: { id: 'preferred-routes', title: 'Routes', count: 1, sourceCount: 1, url: '/nav/preferred-routes.json?v=saved' },
    charts: [], navigation: [{ id: 'airports', title: 'Airports', url: 'cached', minZoom: 0, count: 1, sourceCount: 1 }], weather: [], issues: [] };
  const failed: ChartCatalog = { ...cached, navigation: [], issues: [{ product: 'navigation', message: 'Offline' }] };
  delete failed.preferredRoutes;
  delete failed.routeHistory;
  assert.equal(retainCachedProducts(failed, cached).navigation, cached.navigation);
  assert.equal(retainCachedProducts(failed, cached).preferredRoutes, cached.preferredRoutes);
  assert.equal(retainCachedProducts(failed, cached).routeHistory, cached.routeHistory);
  assert.equal(retainCachedProducts({ ...failed, issues: [{ product: 'route-history', message: 'Invalid metadata' }] }, cached).routeHistory, routeHistory);
  assert.equal(retainCachedProducts({ ...failed, issues: [] }, cached).routeHistory, undefined);
  assert.equal(retainCachedProducts({ ...failed, revision: '2026-10-01' }, cached).routeHistory, undefined);
  assert.equal(retainCachedProducts({ ...failed, revision: '2026-10-01' }, cached).preferredRoutes, undefined);
  assert.deepEqual(retainCachedProducts({ ...failed, revision: '2026-10-01' }, cached).navigation, []);
  assert.deepEqual(retainCachedProducts({ ...failed, issues: [] }, cached).navigation, []);
});

test('saving, resuming and removing a region never adopts another cycle of the same region', async () => {
  const f = fixture();
  const edition = (revision: string): DownloadPlan => ({ ...plan, revision, id: `${revision}|west`,
    files: files.map(file => ({ ...file, url: file.url.replace('charts.test/', `charts.test/${revision}/`) })),
    references: plan.references.map(resource => ({ ...resource, url: resource.url.replace('charts.test/', `charts.test/${revision}/`) })),
  });
  const old = edition('2026-08-06'), current = edition('2026-09-03');
  await f.manager.start(old);
  const oldBytes = new Set(f.cached);
  await f.manager.start(current);
  assert.equal(f.saved.size, 2);
  assert.equal(f.requests.length, old.files.length + current.files.length);
  assert.equal(f.cached.size, oldBytes.size + current.files.length);
  f.cached.delete(old.files[0]!.url);
  const reopened = new RegionDownloads(f.backend);
  await reopened.restore();
  assert.equal(reopened.snapshot().find(job => job.id === old.id)!.state, 'paused');
  assert.equal(reopened.snapshot().find(job => job.id === current.id)!.state, 'complete');
  const before = f.requests.length;
  await reopened.start(old);
  assert.deepEqual(f.requests.slice(before), [old.files[0]!.url]);
  await reopened.remove(old.id);
  assert.deepEqual(f.cached, new Set(current.files.map(file => file.url)));
  assert.deepEqual(f.saved.get(current.id), current);
  await reopened.restore();
  assert.equal(reopened.snapshot()[0]!.state, 'complete');
});

test('completion is committed only after verified transfer and failed commit remains retryable', async () => {
  const f = fixture();
  const commits: DownloadPlan[] = [];
  f.backend.complete = async selection => {
    assert.ok(selection.files.every(file => f.cached.has(file.url)));
    commits.push(selection);
    if (commits.length === 1) throw new Error('Storage transaction failed');
  };
  await f.manager.start(plan);
  assert.equal(f.manager.snapshot()[0]!.state, 'error');
  assert.match(f.manager.snapshot()[0]!.error!, /Storage transaction failed/);
  await f.manager.start(plan);
  assert.equal(f.manager.snapshot()[0]!.state, 'complete');
  assert.equal(commits.length, 2);
  assert.equal(f.requests.length, files.length, 'retry reuses all durable files');
});

test('removal includes retained previous files and protects another region awaiting replacement', async () => {
  const f = fixture();
  const old = { ...plan, files: [files[0]!] };
  const neighbor = { ...plan, id: 'neighbor', files: [files[1]!] };
  f.saved.set(plan.id, old);
  f.saved.set(neighbor.id, { ...neighbor, previous: { ...neighbor, files: old.files } });
  f.cached.add(files[0]!.url); f.cached.add(files[1]!.url);
  await f.manager.restore();
  await f.manager.remove(plan.id);
  assert.deepEqual(f.cached, new Set([files[0]!.url, files[1]!.url]));
  await f.manager.remove(neighbor.id);
  assert.equal(f.cached.size, 0);
});
