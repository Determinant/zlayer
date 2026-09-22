import assert from 'node:assert/strict';
import test from 'node:test';

import { WholeFileChartCache } from '../src/layers/charts/archive-cache.js';
import { ResourceError } from '../src/core/data/errors';
import { cacheFixture } from './helpers/cache';
import { CHART_CACHE, VERIFIED_SHA256_HEADER } from '../src/core/storage/cache-names';

test('coalesces concurrent reads into one whole-file fetch and cache entry', async () => {
  const stored = new Map<string, Response>();
  const cache = {
    match: async (request: RequestInfo | URL) =>
      stored.get(requestUrl(request))?.clone(),
    put: async (request: RequestInfo | URL, response: Response) => {
      stored.set(requestUrl(request), response.clone());
    },
    delete: async (request: RequestInfo | URL) => stored.delete(requestUrl(request)),
  } as Pick<Cache, 'delete' | 'match' | 'put'>;
  const body = new Uint8Array(16_384).fill(7);
  let fetchCount = 0;
  const archives = new WholeFileChartCache(async () => {
    fetchCount += 1;
    await Promise.resolve();
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    });
  });
  const key = await archiveRequest('sectional', body);

  const first = archives.load(cache, key);
  const second = archives.load(cache, key);
  assert.equal(first, second);

  const [left, right] = await Promise.all([first, second]);
  assert.equal(fetchCount, 1);
  assert.equal(left, right);
  assert.equal(left.blob.size, body.byteLength);
  assert.equal(left.headers.get('accept-ranges'), 'bytes');
  assert.equal(stored.size, 1);
});

test('chart download hashes bytes once; explicit saves and fresh readers reuse the durable receipt', async t => {
  const { cache } = cacheFixture(t, CHART_CACHE);
  const body = new Uint8Array(2 * 1024 * 1024 + 17).fill(42);
  const key = await archiveRequest('hash-once', body);
  let hashedBytes = 0;
  const slice = Blob.prototype.slice;
  t.mock.method(Blob.prototype, 'slice', function (this: Blob, start?: number, end?: number, type?: string) {
    const part = slice.call(this, start, end, type);
    hashedBytes += part.size;
    return part;
  });
  const fetch = async () => new Response(body);
  const archives = new WholeFileChartCache(fetch);
  await Promise.all([archives.load(cache, key), archives.ensureStored(cache, key)]);
  assert.equal(hashedBytes, body.length);
  await archives.ensureStored(cache, key);
  await new WholeFileChartCache(fetch).ensureStored(cache, key);
  assert.equal(hashedBytes, body.length, 'restarting the worker must not rehash saved files');
});

test('a network response cannot use a forged verification header to bypass the chart hash', async () => {
  const key = await archiveRequest('untrusted-receipt', new Uint8Array([1, 2, 3]));
  const cache = { match: async () => undefined, put: async () => assert.fail('corrupt bytes must not be saved'), delete: async () => false };
  const archives = new WholeFileChartCache(async () => new Response(new Uint8Array([1, 2, 4]), {
    headers: { [VERIFIED_SHA256_HEADER]: new URL(key.url).searchParams.get('sha256')!, 'content-length': '3' },
  }));
  await assert.rejects(archives.load(cache, key), /SHA-256 mismatch/);
});

test('reuses a persisted whole-file response without an origin fetch', async () => {
  const body = new Uint8Array([1, 2, 3, 4]);
  const key = await archiveRequest('ifr-low', body);
  const response = new Response(body, {
    status: 200,
    headers: { 'x-zlayers-verified-sha256': await sha256(body) },
  });
  const cache = {
    match: async () => response.clone(),
    put: async () => undefined,
    delete: async () => false,
  } as Pick<Cache, 'delete' | 'match' | 'put'>;
  const archives = new WholeFileChartCache(async () => {
    throw new Error('origin fetch should not run');
  });

  const archive = await archives.load(cache, key);
  assert.equal(archive.blob.size, 4);
});

test('a temporarily unreadable cached chart reopens its response without deleting or fetching it', async () => {
  const body = new Uint8Array([1, 2, 3]);
  const key = await archiveRequest('unreadable', body);
  let reads = 0, deletions = 0;
  const cache = {
    match: async () => {
      const response = new Response(body, { headers: { 'x-zlayers-verified-sha256': await sha256(body) } });
      if (++reads === 1) response.blob = async () => { throw new DOMException('unreadable', 'NotReadableError'); };
      return response;
    },
    put: async () => { throw new Error('no write needed'); },
    delete: async () => { deletions++; return true; },
  };
  const archives = new WholeFileChartCache(async () => { throw new Error('must work offline'); });
  assert.equal((await archives.load(cache, key)).blob.size, body.length);
  assert.equal(reads, 2);
  assert.equal(deletions, 0);
});

test('persistently unreadable chart repair keeps old bytes until a verified replacement can be saved', async () => {
  const body = new Uint8Array([1, 2, 3]);
  const key = await archiveRequest('repair-unreadable', body);
  let deletes = 0, writes = 0, fetches = 0, online = false;
  const cache = {
    match: async () => { throw new DOMException('unreadable', 'NotReadableError'); },
    put: async (_key: RequestInfo | URL, response: Response) => {
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()), body);
      writes++;
    },
    delete: async () => { deletes++; return true; },
  };
  const archives = new WholeFileChartCache(async () => {
    fetches++;
    if (!online) throw new TypeError('offline');
    return new Response(body);
  });
  await assert.rejects(archives.load(cache, key), /offline/);
  assert.equal(writes, 0);
  assert.equal(deletes, 0);
  online = true;
  assert.equal((await archives.load(cache, key)).blob.size, body.length);
  assert.equal(writes, 1);
  assert.equal(deletes, 0);
  assert.equal(fetches, 2);
});

test('permission-denied chart storage stops without deleting files or fetching a replacement', async () => {
  const key = await archiveRequest('denied', new Uint8Array([1]));
  const cache = {
    match: async () => { throw new DOMException('denied', 'SecurityError'); },
    put: async () => { throw new Error('unexpected write'); },
    delete: async () => { throw new Error('unexpected delete'); },
  };
  const archives = new WholeFileChartCache(async () => { throw new Error('unexpected fetch'); });
  await assert.rejects(archives.load(cache, key), error => error instanceof ResourceError && error.code === 'storage');
});

test('explicit chart saves release header-only responses before returning', async () => {
  const body = new Uint8Array([1]);
  const key = await archiveRequest('release-receipt', body);
  const sha256 = new URL(key.url).searchParams.get('sha256')!;
  let saved = false, cancelled = 0;
  const cache = {
    match: async () => saved ? new Response(new ReadableStream({ cancel() { cancelled++; } }), {
      headers: { 'x-zlayers-verified-sha256': sha256, 'content-length': '1' },
    }) : undefined,
    put: async () => { saved = true; }, delete: async () => false,
  };
  const archives = new WholeFileChartCache(async () => new Response(body));
  await archives.ensureStored(cache, key);
  assert.equal(cancelled, 1);
});

test('reports one coalesced archive failure and permits a retry', async () => {
  const cache = {
    match: async () => undefined,
    put: async () => undefined,
    delete: async () => false,
  } as Pick<Cache, 'delete' | 'match' | 'put'>;
  let fetchCount = 0;
  let errorCount = 0;
  const archives = new WholeFileChartCache(async () => {
    fetchCount += 1;
    if (fetchCount === 1) throw new Error('CORS blocked');
    return new Response(new Uint8Array([1]), { status: 200 });
  });
  const key = await archiveRequest('retry', new Uint8Array([1]));

  const first = archives.load(cache, key, () => {
    errorCount += 1;
  });
  const concurrent = archives.load(cache, key, () => {
    errorCount += 1;
  });
  await assert.rejects(Promise.all([first, concurrent]), /CORS blocked/);
  assert.equal(fetchCount, 1);
  assert.equal(errorCount, 1);

  const retried = await archives.load(cache, key);
  assert.equal(retried.blob.size, 1);
  assert.equal(fetchCount, 2);
});

test('bounds resident blobs while retaining verified whole files in Cache Storage', async () => {
  const stored = new Map<string, Response>();
  const cache = {
    match: async (request: RequestInfo | URL) => stored.get(requestUrl(request))?.clone(),
    put: async (request: RequestInfo | URL, response: Response) => {
      stored.set(requestUrl(request), response.clone());
    },
    delete: async (request: RequestInfo | URL) => stored.delete(requestUrl(request)),
  } as Pick<Cache, 'delete' | 'match' | 'put'>;
  let fetchCount = 0;
  const archives = new WholeFileChartCache(async (request) => {
    fetchCount += 1;
    return new Response(new URL(request.url).pathname.endsWith('/first.mbtiles')
      ? new Uint8Array([1])
      : new Uint8Array([2]), { status: 200 });
  }, 1);
  const first = await archiveRequest('first', new Uint8Array([1]));
  const second = await archiveRequest('second', new Uint8Array([2]));

  await archives.load(cache, first);
  await archives.load(cache, second);
  const reloaded = await archives.load(cache, first);

  assert.equal(fetchCount, 2);
  assert.equal(reloaded.blob.size, 1);
  assert.equal(stored.size, 2);
});

test('rejects bytes that do not match the publisher identity', async () => {
  const expected = new Uint8Array([1, 2, 3]);
  const stored = new Map<string, Response>();
  const cache = {
    match: async (request: RequestInfo | URL) => stored.get(requestUrl(request))?.clone(),
    put: async (request: RequestInfo | URL, response: Response) => {
      stored.set(requestUrl(request), response.clone());
    },
    delete: async (request: RequestInfo | URL) => stored.delete(requestUrl(request)),
  } as Pick<Cache, 'delete' | 'match' | 'put'>;

  const wrongSize = new WholeFileChartCache(async () =>
    new Response(new Uint8Array([1, 2]), { status: 200 })
  );
  await assert.rejects(
    wrongSize.load(cache, await archiveRequest('wrong-size', expected)),
    /size mismatch/,
  );

  const wrongHash = new WholeFileChartCache(async () =>
    new Response(new Uint8Array([1, 2, 4]), { status: 200 })
  );
  await assert.rejects(
    wrongHash.load(cache, await archiveRequest('wrong-hash', expected)),
    /SHA-256 mismatch/,
  );
  assert.equal(stored.size, 0);
});

test('bounds whole-file downloads while cached archives bypass the queue', async () => {
  const body = new Uint8Array([1, 2, 3]);
  const persisted = await archiveRequest('persisted', body);
  const stored = new Map<string, Response>([[persisted.url, new Response(body, {
    headers: { 'x-zlayers-verified-sha256': await sha256(body) },
  })]]);
  const cache = {
    match: async (request: RequestInfo | URL) => stored.get(requestUrl(request))?.clone(),
    put: async (request: RequestInfo | URL, response: Response) => {
      stored.set(requestUrl(request), response.clone());
    },
    delete: async (request: RequestInfo | URL) => stored.delete(requestUrl(request)),
  };
  const gates = Array.from({ length: 6 }, () => deferred<Response>());
  const started = gates.map(() => deferred<void>());
  let fetches = 0;
  const archives = new WholeFileChartCache(async (request) => {
    assert.equal(request.method, 'GET');
    assert.equal(request.headers.has('range'), false);
    const index = fetches++;
    started[index]!.resolve();
    return gates[index]!.promise;
  });
  const keys = await Promise.all(gates.map((_, index) => archiveRequest(`sheet-${index}`, body)));
  const reads = keys.map((key) => archives.load(cache, key));
  await Promise.all(started.slice(0, 4).map(gate => gate.promise));
  assert.equal(fetches, 4);
  assert.equal(archives.load(cache, keys[4]!), reads[4]); // coalesce even while queued
  assert.equal((await archives.load(cache, persisted)).blob.size, body.length);
  assert.equal(fetches, 4);

  // A failed download must release its slot for the next archive.
  const failed = assert.rejects(reads[0]!, /offline/);
  gates[0]!.reject(new Error('offline'));
  await failed;
  await started[4]!.promise;
  assert.equal(fetches, 5);

  gates[1]!.resolve(new Response(body));
  await reads[1];
  await started[5]!.promise;
  gates.slice(2).forEach(gate => gate.resolve(new Response(body)));
  await Promise.all(reads.slice(1));
  assert.equal(fetches, 6);
  assert.equal(stored.size, 6); // five downloaded archives and the persisted one
});

test('large sheets hold the entire download budget through verification and persistence', async () => {
  const small = new Uint8Array([42]);
  const large = new Uint8Array(4 * 1024 * 1024 + 1);
  const bodies = [large, large, small, small, small, small];
  const gates = bodies.map(() => deferred<Response>());
  const started = bodies.map(() => deferred<void>());
  const cache = { match: async () => undefined, put: async () => {}, delete: async () => false };
  let fetches = 0;
  const archives = new WholeFileChartCache(async () => {
    const i = fetches++;
    started[i]!.resolve();
    return gates[i]!.promise;
  });
  const keys = await Promise.all(bodies.map((body, i) => archiveRequest(`weighted-${i}`, body)));
  const reads = keys.map(key => archives.load(cache, key));
  await started[0]!.promise;
  assert.equal(fetches, 1, 'one large sheet fills the budget');
  gates[0]!.resolve(new Response(large));
  await reads[0];
  await started[1]!.promise;
  assert.equal(fetches, 2, 'the next large sheet also runs alone');
  gates[1]!.resolve(new Response(large));
  await reads[1];
  await Promise.all(started.slice(2).map(gate => gate.promise));
  assert.equal(fetches, 6, 'four small packages now download concurrently');
  gates.slice(2).forEach(gate => gate.resolve(new Response(small)));
  await Promise.all(reads);
});

test('resident chart bytes are bounded even before the file-count limit is reached', async () => {
  const body = new Uint8Array(6 * 1024 * 1024);
  const keys = await Promise.all(['byte-first', 'byte-second', 'byte-third'].map(name => archiveRequest(name, body)));
  const stored = new Set<string>();
  const matches: string[] = [];
  const hash = await sha256(body);
  const cache = {
    match: async (key: RequestInfo | URL) => {
      const url = requestUrl(key); matches.push(url);
      return stored.has(url) ? new Response(body, { headers: {
        'content-length': String(body.length), 'x-zlayers-verified-sha256': hash,
      } }) : undefined;
    },
    put: async (key: RequestInfo | URL) => { stored.add(requestUrl(key)); },
    delete: async () => false,
  };
  let fetches = 0;
  const archives = new WholeFileChartCache(async () => { fetches++; return new Response(body); });
  for (const key of keys) await archives.load(cache, key);
  const before = matches.length;
  await archives.load(cache, keys[1]!);
  assert.equal(matches.length, before, 'a recent archive remains resident');
  await archives.load(cache, keys[0]!);
  assert.equal(matches.length, before + 1, 'the oldest archive was released at 18 MiB despite only three files');
  assert.equal(fetches, 3, 'eviction releases RAM and preserves the saved files');
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

async function archiveRequest(name: string, body: Uint8Array): Promise<Request> {
  return new Request(
    `https://charts.test/${name}.mbtiles?sha256=${await sha256(body)}&bytes=${body.byteLength}`,
  );
}

async function sha256(body: Uint8Array): Promise<string> {
  const bytes = body.buffer.slice(
    body.byteOffset,
    body.byteOffset + body.byteLength,
  ) as ArrayBuffer;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

function requestUrl(request: RequestInfo | URL): string {
  if (request instanceof Request) return request.url;
  if (request instanceof URL) return request.href;
  return new URL(request).href;
}

test('explicit saves restore an evicted durable entry from memory and retry failed writes', async () => {
  const body = new Uint8Array([8, 2, 6]);
  const key = await archiveRequest('repair', body);
  let stored: Response | undefined;
  let writes = 0, fetches = 0, full = false;
  const cache = {
    match: async () => stored?.clone(),
    delete: async () => { stored = undefined; return true; },
    put: async (_key: RequestInfo | URL, response: Response) => {
      writes++;
      if (full) throw new DOMException('full', 'QuotaExceededError');
      stored = response.clone();
    },
  };
  const archives = new WholeFileChartCache(async () => { fetches++; return new Response(body); });
  await archives.ensureStored(cache, key);
  assert.equal(writes, 1);
  await archives.ensureStored(cache, key);
  assert.equal(writes, 1, 'retained entries do not need another write');
  await cache.delete(); full = true;
  await assert.rejects(archives.ensureStored(cache, key), { name: 'QuotaExceededError' });
  full = false;
  await archives.ensureStored(cache, key);
  assert.equal(fetches, 1, 'the already verified Blob repairs storage without another download');
  assert.deepEqual(new Uint8Array(await stored!.arrayBuffer()), body);
});

test('an unreadable retained Blob is evicted so retry can save a fresh chart', async () => {
  const body = new Uint8Array([1, 2, 3]);
  const key = await archiveRequest('expired-blob', body);
  let stored: Response | undefined;
  let unreadable = false, fetches = 0;
  const cache = {
    match: async () => stored?.clone(),
    put: async (_key: RequestInfo | URL, response: Response) => {
      if (unreadable) throw new DOMException('unreadable retained blob', 'NotReadableError');
      stored = response.clone();
    },
    delete: async () => { stored = undefined; return true; },
  };
  const archives = new WholeFileChartCache(async () => { fetches++; return new Response(body); });
  await archives.ensureStored(cache, key);
  stored = undefined; unreadable = true;
  await assert.rejects(archives.ensureStored(cache, key), { name: 'NotReadableError' });
  unreadable = false;
  await archives.ensureStored(cache, key);
  assert.equal(fetches, 2);
  assert.deepEqual(new Uint8Array(await stored!.arrayBuffer()), body);
});
