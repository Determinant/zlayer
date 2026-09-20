import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test from 'node:test';
import { purgeLocalData } from '../src/core/storage/reset';

test('a failed reset message releases its ports and worker listener before retrying', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const worker = Object.assign(new EventTarget(), {
    state: 'activated',
    postMessage(message: { type: string }) {
      if (message.type === 'prepare-reset') throw new DOMException('Worker became unavailable', 'InvalidStateError');
    },
  });
  const channels: Array<{ closed: string[] }> = [];
  class Channel {
    closed: string[] = [];
    port1 = { onmessage: undefined, close: () => this.closed.push('port1') };
    port2 = { close: () => this.closed.push('port2') };
    constructor() { channels.push(this); }
  }
  const globals = {
    MessageChannel: Channel,
    navigator: {
      serviceWorker: { controller: worker, getRegistrations: async () => [] },
      locks: { request: async (_name: string, callback: () => Promise<void>) => callback() },
    },
    localStorage: { getItem: () => '1' },
  };
  for (const [name, value] of Object.entries(globals)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => original ? Object.defineProperty(globalThis, name, original) : Reflect.deleteProperty(globalThis, name));
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(purgeLocalData(() => {}), /Worker became unavailable/);
    assert.equal(getEventListeners(worker, 'statechange').length, 0);
    assert.deepEqual(channels[attempt]!.closed, ['port1', 'port2']);
  }
  t.mock.timers.tick(180_000);
  assert.ok(channels.every(channel => channel.closed.length === 2), 'failed sends must cancel their timeout');
});
