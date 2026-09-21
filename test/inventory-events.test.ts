import assert from 'node:assert/strict';
import test from 'node:test';
import { notifyOfflineInventory, observeOfflineInventory } from '../src/offline/inventory-events';

for (const failure of ['unavailable', 'constructor', 'send']) test(`inventory notification preserves local delivery when BroadcastChannel fails: ${failure}`, t => {
  let closed = 0;
  class Channel {
    onmessage: (() => void) | undefined;
    constructor() { if (failure === 'constructor') throw new DOMException('Denied', 'SecurityError'); }
    postMessage() { throw new DOMException('Closed', 'InvalidStateError'); }
    close() { closed++; }
  }
  for (const [name, value] of Object.entries({ window: new EventTarget(),
    BroadcastChannel: failure === 'unavailable' ? undefined : Channel })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : Reflect.deleteProperty(globalThis, name));
  }
  let updates = 0;
  const stop = observeOfflineInventory(() => updates++);
  assert.doesNotThrow(notifyOfflineInventory);
  assert.equal(updates, 1);
  stop();
  assert.equal(closed, failure === 'send' ? 2 : 0, 'both sender and observer release their channels');
  notifyOfflineInventory();
  assert.equal(updates, 1, 'unsubscribed views no longer refresh');
});
