// node --expose-gc --import=tsx tools/benchmark-terminal-index.mjs <nav-directory> <output.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRouteResolver } from '@zlayer/domain';
const [directory, output] = process.argv.slice(2);
if (!directory || !output) throw Error('Expected nav directory and output JSON');
const manifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json')));
const read = id => JSON.parse(readFileSync(resolve(directory, manifest.products.find(p => p.id === id).file)));
const terminal = read('terminal-procedures');
const collections = ['airports', 'fixes', 'vfr-waypoints', 'navaids'].map(layer => {
  const data = read(layer);
  return { ...data, meta: { layer, revision: manifest.effectiveDate, returned: data.features.length, truncated: false } };
});
const airport = collections[0].features.find(f => f.properties.icaoId === 'KVGT');
if (!airport) throw Error('KVGT fixture unavailable');
const local = [{ ...collections[0], features: [airport], meta: { ...collections[0].meta, returned: 1 } }];
const measure = (name, collections, data) => {
  global.gc?.(); const heap = process.memoryUsage().heapUsed, start = performance.now();
  const resolver = createRouteResolver(collections, undefined, data);
  const milliseconds = performance.now() - start;
  global.gc?.(); const retainedMiB = (process.memoryUsage().heapUsed - heap) / 2 ** 20;
  const plan = resolver('KVGT');
  return { name, milliseconds, retainedMiB, waypoints: plan.waypoints.length };
};
const result = { effectiveDate: manifest.effectiveDate, node: process.version, measurements: [
  measure('one-airport-first-terminal-use', local, terminal),
  measure('one-airport-shared-terminal-index', local, terminal),
  measure('national-navigation-first-use', collections, terminal),
  measure('airport-preview-shared-navigation', [...local, ...collections.slice(1)], terminal),
] };
writeFileSync(output, JSON.stringify(result, null, 2)+'\n');
console.log(JSON.stringify(result, null, 2));
