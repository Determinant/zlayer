// Run from zlayers: node --import=tsx tools/verify-publisher-contracts.mjs [../faa-regs]
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { isNavigationManifest, isTerminalProceduresData, REQUIRED_NAVIGATION_PRODUCTS } from '@zlayer/contracts';
import { terminalProceduresDocumentGuard } from '../src/core/data/references.ts';

const root = resolve(process.argv[2] ?? '../faa-regs');
const { buildTerminalBundle } = await import(pathToFileURL(resolve(root, 'lib/terminal-bundle.ts')));
const { jsonArtifact } = await import(pathToFileURL(resolve(root, 'lib/publication.ts')));
const topology = JSON.parse(await readFile(resolve(root, 'test/fixtures/terminal-procedures.json'), 'utf8'));
const raw = await readFile(resolve(root, 'test/fixtures/terminal-cifp.txt'), 'utf8');
const hash = createHash('sha256').update(raw).digest('hex');
const date = '2026-09-03';
const data = buildTerminalBundle(topology, raw, date, { group: 'CIFP', filename: 'FAACIFP18',
  url: 'https://example.test/FAACIFP18', sha256: hash, recordFile: { filename: 'FAACIFP18', sha256: hash, bytes: Buffer.byteLength(raw) } });
const product = { id: 'terminal-procedures', schemaVersion: 2, coverage: data.coverage,
  count: data.procedures.length, ...jsonArtifact('terminal-procedures.json', data) };
const manifest = { schemaVersion: 2, effectiveDate: date, generatedAt: new Date().toISOString(),
  products: REQUIRED_NAVIGATION_PRODUCTS.map(id => id === product.id ? product : { id, count: 1, ...jsonArtifact(`${id}.json`, { id }) }) };
assert.ok(isNavigationManifest(manifest));
assert.equal(isNavigationManifest({ ...manifest, products: manifest.products.filter(p => p.id !== product.id) }), false);
assert.equal(isNavigationManifest({ ...manifest, schemaVersion: '2' }), false);
const resource = { ...product, title: 'Terminal procedures', sourceCount: product.count, url: `https://example.test/${product.file}` };
const guard = terminalProceduresDocumentGuard(resource, date);
assert.ok(guard(data));
for (const family of ['approaches', 'codedProcedures']) {
  const missing = { ...data };
  delete missing[family];
  assert.equal(guard(missing), false, `missing ${family}`);
  assert.equal(isTerminalProceduresData(missing, date), false, `v2 requires ${family}`);
}
assert.equal(guard({ ...data, metadata: { ...data.metadata, source: 'same-count replacement' } }), false);
assert.equal(guard({ type: data.type, metadata: { effectiveDate: date, source: 'legacy' }, procedures: data.procedures }), false);
assert.equal(guard({ ...data, coverage: { ...data.coverage, approaches: 0 } }), false);
console.log('Publisher-to-consumer terminal contract checks passed.');

const { associateApproachCharts } = await import(pathToFileURL(resolve(root, 'lib/approach-associations.ts')));
const { isProcedureCatalog, isApproachAssociations } = await import('@zlayer/contracts');
const charts = JSON.parse(await readFile(resolve(root, 'test/fixtures/approach-association-charts.json'), 'utf8'));
const routes = JSON.parse(await readFile(resolve(root, 'test/fixtures/approach-association-routes.json'), 'utf8'));
const reviews = JSON.parse(await readFile(resolve(root, 'data/approach-associations/2026-09-03.json'), 'utf8'));
const associations = associateApproachCharts(charts, routes, { ...reviews.sources, terminalJsonSha256: product.jsonSha256 }, reviews.entries);
assert.ok(isApproachAssociations(associations));
assert.ok(isProcedureCatalog({ ...charts, associations }));
assert.equal(isProcedureCatalog({ ...charts, associations: { ...associations, records: associations.records.slice(1) } }), false);
assert.equal(isProcedureCatalog({ ...charts, associations: { ...associations, sources: { ...associations.sources, chartXmlSha256: '0'.repeat(64) } } }), false);
console.log('Publisher-to-consumer chart association contract checks passed.');
