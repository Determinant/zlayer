import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test as base, expect } from '@playwright/test';

// WebKit's ephemeral contexts deny OPFS even when the API is exposed. Exercise
// normal persistent browsing, as used by the installed app, in a fresh profile.
const test = base.extend({
  context: async ({ playwright, browserName, baseURL }, use) => {
    const directory = await mkdtemp(join(tmpdir(), 'zlayer-download-profile-'));
    const context = await playwright[browserName].launchPersistentContext(directory, {
      ...(baseURL ? { baseURL } : {}),
    });
    try {
      await context.addInitScript(() => {
        localStorage.setItem('zlayer-ui:welcome-acknowledged', JSON.stringify({ version: 1, value: true }));
      });
      await use(context);
    } finally { await context.close(); await rm(directory, { recursive: true, force: true }); }
  },
});
test.beforeEach(async ({ request }) => { await request.post('/__test/reset'); });
test.afterEach(async ({ request }) => { await request.post('/__test/reset'); });

test('180 MiB book streams to disk, survives reload offline, and is removed with its receipt', async ({ page, context }) => {
  test.setTimeout(120_000);
  const size = 180 * 1024 * 1024;
  const chunk = Buffer.alloc(256 * 1024);
  chunk.write('%PDF-1.7\n');
  const hash = createHash('sha256').update(chunk);
  chunk.fill(0);
  for (let offset = chunk.length; offset < size; offset += chunk.length) hash.update(chunk);
  const sha256 = hash.digest('hex');
  await page.goto('/');
  const saved = await page.evaluate(async ({ size, sha256 }) => {
    const module = '/assets/download-memory-test.js';
    return (await import(module)).save(size, sha256);
  }, { size, sha256 });
  expect(saved).toEqual({ saved: true, size, loaded: size, requested: 1,
    maxWrite: 64 * 1024, receiptBytes: 0, available: size, prefix: '%PDF-1.7\n' });
  await page.reload();
  const reopened = await page.evaluate(async ({ size, sha256 }) => {
    const module = '/assets/download-memory-test.js';
    return (await import(module)).reopen(size, sha256);
  }, { size, sha256 });
  expect(reopened).toEqual({ saved: true, size, prefix: '%PDF-1.7\n', tail: [0, 0, 0, 0] });
  // Closing the reader deterministically releases its file locks on every engine.
  await page.close();
  const remover = await context.newPage();
  await remover.goto('/');
  const removed = await remover.evaluate(async ({ size, sha256 }) => {
    const module = '/assets/download-memory-test.js';
    return (await import(module)).remove(size, sha256);
  }, { size, sha256 });
  expect(removed).toEqual({ remaining: [], available: null });
});

test('large service-worker chart downloads keep only a receipt and serve saved ranges offline', async ({ page, request }) => {
  const size = 20 * 1024 * 1024;
  const hash = createHash('sha256');
  const chunk = Buffer.alloc(256 * 1024);
  for (let offset = 0; offset < size; offset += chunk.length) hash.update(chunk);
  const url = `/chart-data/download-memory/archive.mbtiles?bytes=${size}&sha256=${hash.digest('hex')}`;
  await page.goto('/');
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const download = await page.evaluate(async url => {
    const response = await fetch(url, { method: 'HEAD' });
    const receipt = await (await caches.open('zlayers-file-receipts-v1:zlayers-chart-archives-v3')).match(url);
    return { status: response.status, bytes: Number(response.headers.get('content-length')),
      receiptBytes: receipt ? (await receipt.blob()).size : undefined };
  }, url);
  expect(download).toEqual({ status: 200, bytes: size, receiptBytes: 0 });
  // Fail the real origin, including worker requests. Linux WebKit's protocol
  // offline emulation also rejects otherwise local service-worker responses.
  await request.post('/__test/disconnect');
  const read = await page.evaluate(async ({ url, size }) => {
    const response = await fetch(url, { headers: { range: `bytes=${size - 32}-${size - 1}` } });
    return { status: response.status, bytes: [...new Uint8Array(await response.arrayBuffer())] };
  }, { url, size });
  expect(read).toEqual({ status: 206, bytes: Array(32).fill(0) });
});

test('two windows can finish the same book and keep reading through replacement and removal', async ({ page, context }) => {
  const size = 10 * 1024 * 1024;
  const chunk = Buffer.alloc(256 * 1024); chunk.write('%PDF-1.7\n');
  const hash = createHash('sha256').update(chunk); chunk.fill(0);
  for (let offset = chunk.length; offset < size; offset += chunk.length) hash.update(chunk);
  const sha256 = hash.digest('hex');
  const other = await context.newPage(), remover = await context.newPage();
  await page.goto('/'); await other.goto('/'); await remover.goto('/');
  const save = (target: typeof page) => target.evaluate(async ({ size, sha256 }) => {
    const module = '/assets/download-memory-test.js';
    return (await import(module)).save(size, sha256, true, true);
  }, { size, sha256 });
  const waitForDownload = (target: typeof page) => expect.poll(() => target.evaluate(async () => {
    const module = '/assets/download-memory-test.js';
    return (await import(module)).isWaiting();
  })).toBe(true);
  const resume = (target: typeof page) => target.evaluate(async () => {
    const module = '/assets/download-memory-test.js'; (await import(module)).resume();
  });
  const first = save(page); await waitForDownload(page);
  const second = save(other); await waitForDownload(other);
  await resume(page); expect((await first).saved).toBe(true);
  await resume(other); expect((await second).saved).toBe(true);
  // A previous release only reads this legacy cache, and cannot delete the new receipt.
  expect(await remover.evaluate(async ({ size, sha256 }) => {
    const url = `${location.origin}/large-memory-test.pdf?bytes=${size}&sha256=${sha256}`;
    const legacy = await caches.open('zlayers-procedures-v1');
    const stored = await legacy.match(url);
    await legacy.delete(url);
    return stored === undefined;
  }, { size, sha256 })).toBe(true);
  const removed = await remover.evaluate(async ({ size, sha256 }) => {
    const module = '/assets/download-memory-test.js';
    return (await import(module)).remove(size, sha256);
  }, { size, sha256 });
  expect(removed.available).toBeNull();
  const prefix = [...new TextEncoder().encode('%PDF-1.7\n')];
  for (const reader of [page, other]) {
    await reader.requestGC(); // Only the nested slice remains; its File must survive.
    expect(await reader.evaluate(async () => {
      const module = '/assets/download-memory-test.js'; return (await import(module)).readHeld();
    })).toEqual(prefix);
  }
  await other.close(); // Closing one reader cannot release the other window's file.
  await page.evaluate(async () => {
    const module = '/assets/download-memory-test.js'; (await import(module)).releaseHeld();
  });
  await expect.poll(async () => {
    await page.requestGC(); // Unused readers must release storage even while the page stays open.
    return remover.evaluate(async () => {
      const module = '/assets/download-memory-test.js'; return (await import(module)).remainingFiles();
    });
  }, { timeout: 10_000 }).toEqual([]);
});
