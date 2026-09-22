import assert from 'node:assert/strict';
import test from 'node:test';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { MapLayerHost } from '../src/core/map/layer';
import { createRulerLayer } from '../src/layers/ruler/layer';
import { createRulerMapLayer } from '../src/layers/ruler/map';

class ElementStub extends EventTarget {
  listeners = new Set<EventListenerOrEventListenerObject>();
  children = new Set<ElementStub>();
  parent?: ElementStub;
  dataset = {}; style = {}; className = ''; textContent = ''; type = '';
  classList = { toggle() {}, remove() {} };
  setAttribute() {}
  append(...children: ElementStub[]) { for (const child of children) { this.children.add(child); child.parent = this; } }
  remove() { this.parent?.children.delete(this); }
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean) {
    if (listener) this.listeners.add(listener);
    super.addEventListener(type, listener, options);
  }
  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean) {
    if (listener) this.listeners.delete(listener);
    super.removeEventListener(type, listener, options);
  }
}

test('ruler unwinds partial renderer and interaction setup, then reloads without accumulating resources', t => {
  const window = new ElementStub(), document = new ElementStub();
  const elements: ElementStub[] = [window, document];
  const element = () => { const value = new ElementStub(); elements.push(value); return value; };
  Object.assign(document, { createElement: element, createElementNS: element });
  let failObserver = false, observers = 0;
  class Observer {
    observe() { if (failObserver) throw new Error('observer setup failed'); }
    constructor() { observers++; }
    disconnect() { observers--; }
  }
  for (const [key, value] of Object.entries({ window, document, ResizeObserver: Observer })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, key, previous) : Reflect.deleteProperty(globalThis, key));
  }
  const sources = new Set<string>(), layers = new Set<string>(), events = new Set<unknown>();
  const canvas = element(), container = element();
  let failLayer = true, subscriptions = 0;
  const product = createRulerLayer();
  const map = {
    addSource(id: string) { sources.add(id); },
    addLayer(layer: { id: string }) { if (failLayer && layers.size) throw new Error('layer setup failed'); layers.add(layer.id); },
    getLayer: (id: string) => layers.has(id), getSource: (id: string) => sources.has(id),
    removeLayer(id: string) { layers.delete(id); }, removeSource(id: string) { sources.delete(id); },
    getCanvas: () => canvas, getContainer: () => container, moveLayer() {},
    on(_type: string, handler: unknown) { events.add(handler); }, off(_type: string, handler: unknown) { events.delete(handler); },
    doubleClickZoom: { isEnabled: () => true, disable() {}, enable() {} },
  } as unknown as MapLibreMap;
  const errors: unknown[] = [];
  const host = new MapLayerHost(map, (_id, error) => errors.push(error));
  const adapter = () => createRulerMapLayer({ ...product, subscribe(listener) {
    subscriptions++;
    const unsubscribe = product.subscribe(listener);
    return () => { subscriptions--; unsubscribe(); };
  } });
  const assertReleased = () => {
    assert.equal(sources.size + layers.size + events.size + observers + subscriptions, 0);
    assert.equal(container.children.size, 0);
    assert.ok(elements.every(element => element.listeners.size === 0));
  };
  host.mount([adapter()]); host.unmount(); assertReleased();
  failLayer = false; failObserver = true;
  host.mount([adapter()]); host.unmount(); assertReleased();
  assert.equal(errors.length, 2);
  failObserver = false;
  for (let i = 0; i < 30; i++) { host.mount([adapter()]); host.unmount(); assertReleased(); }
  assert.equal(errors.length, 2);
});
