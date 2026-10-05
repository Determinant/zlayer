import { parentPort } from 'node:worker_threads';
import { createReadStream, openSync, closeSync, writeSync } from 'node:fs';
import { open, readFile, rm } from 'node:fs/promises';
import { createGunzip } from 'node:zlib';
import { isRecord } from '@zlayer/contracts';
import { createNotamXmlParser } from './notams/normalize';
import { NotamError, notamError } from './notams/error';
import { NOTAM_GENERATION_MAX_BYTES } from './notams/store';

parentPort!.once('message', async (input: { path: string; output: string; kind: 'bulk' | 'delta'; requestedAt: number }) => {
  const file = openSync(input.output, 'wx', 0o600); let bytes = 0;
  try {
    const emit: Parameters<typeof createNotamXmlParser>[0] = record => {
      const line = JSON.stringify(record) + '\n'; bytes += Buffer.byteLength(line);
      if (bytes > NOTAM_GENERATION_MAX_BYTES) throw new NotamError('dataset-size-limit');
      const buffer = Buffer.from(line);
      for (let offset = 0; offset < buffer.length;) {
        const written = writeSync(file, buffer, offset, buffer.length - offset);
        if (!written) throw new NotamError('storage-unavailable');
        offset += written;
      }
    };
    let summary: { snapshotAt: number; count: number };
    if (input.kind === 'bulk') {
      const handle = await open(input.path, 'r'), signature = Buffer.alloc(2);
      try { await handle.read(signature, 0, 2, 0); } finally { await handle.close(); }
      const source = createReadStream(input.path), gzip = signature[0] === 0x1f && signature[1] === 0x8b;
      const stream = gzip ? source.pipe(createGunzip()) : source;
      if (gzip) source.on('error', error => stream.destroy(error));
      const parser = createNotamXmlParser(emit), decoder = new TextDecoder('utf-8', { fatal: true });
      try {
        for await (const chunk of stream) parser.write(decoder.decode(chunk as Buffer, { stream: true }));
        parser.write(decoder.decode()); summary = parser.finish();
      } finally { stream.destroy(); source.destroy(); }
    } else {
      let envelope: unknown;
      try { envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readFile(input.path))); }
      catch { throw new NotamError('invalid-envelope'); }
      if (!isRecord(envelope) || envelope.status !== 'Success' ||
        envelope.errors !== undefined && (!Array.isArray(envelope.errors) || envelope.errors.length > 0) ||
        !isRecord(envelope.data) || !Array.isArray(envelope.data.aixm) || envelope.data.aixm.length > 150_000 ||
        !envelope.data.aixm.every(v => typeof v === 'string')) throw new NotamError('invalid-envelope');
      for (const xml of envelope.data.aixm) {
        const parser = createNotamXmlParser(emit, { count: 1, snapshotAt: input.requestedAt });
        parser.write(xml); parser.finish();
      }
      summary = { snapshotAt: input.requestedAt, count: envelope.data.aixm.length };
    }
    parentPort!.postMessage({ type: 'done', value: { ...summary, bytes } });
  } catch (cause) {
    await rm(input.output, { force: true });
    parentPort!.postMessage({ type: 'error', error: { code: 'processing', message: notamError(cause) } });
  } finally { closeSync(file); }
});
