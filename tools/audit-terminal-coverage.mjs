// Read-only national audit, independent of plate-title matching.
// node --import=tsx tools/audit-terminal-coverage.mjs <nav-directory> <report.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { isTerminalProceduresData } from '@zlayer/contracts';
import { terminalPaths, approachEntryOptions, approachPreview } from '@zlayer/domain';
import { resolveApproachLegs } from '../packages/domain/src/approach-path.ts';

const [directory, output] = process.argv.slice(2);
if (!directory || !output) throw new Error('Usage: node --import=tsx tools/audit-terminal-coverage.mjs <nav-directory> <report.json>');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json')));
const bytes = readFileSync(resolve(directory, manifest.products.find(p => p.id === 'terminal-procedures').file));
const data = JSON.parse(bytes);
if (!isTerminalProceduresData(data) || !data.codedProcedures || !data.approaches) throw new Error('A complete coded terminal edition is required');
if (manifest.effectiveDate !== data.metadata.effectiveDate) throw new Error('Manifest edition mismatch');
let sourceText;
for (const id of ['terminal-procedures', 'cifp-source']) {
  const product = manifest.products.find(p => p.id === id);
  if (!product) throw new Error(`Missing product: ${id}`);
  const content = readFileSync(resolve(directory, product.file));
  if (content.length !== product.bytes || hash(content) !== product.sha256) throw new Error(`Integrity mismatch: ${id}`);
  if (id === 'cifp-source') {
    const decoded = gunzipSync(content);
    if (hash(decoded) !== product.decodedSha256) throw new Error('CIFP source hash mismatch');
    sourceText = decoded.toString('utf8');
  }
}
// Recount independently of the publisher's coverage fields.
const sourceCounts = { departure: 0, arrival: 0, approach: 0 }, exportedCounts = { ...sourceCounts };
const continuationCounts = { source: 0, exported: 0 };
for (const line of sourceText.split(/\r?\n/)) {
  if (line[0] !== 'S' || !['P', 'H'].includes(line[4]) || !['D', 'E', 'F'].includes(line[12])) continue;
  if (['0', '1'].includes(line[38])) sourceCounts[{ D: 'departure', E: 'arrival', F: 'approach' }[line[12]]]++;
  else continuationCounts.source++;
}
const count = (kind, legs) => {
  exportedCounts[kind] += legs.length;
  continuationCounts.exported += legs.reduce((n, leg) => n + (leg.continuations?.length ?? 0), 0);
};
for (const p of data.codedProcedures.procedures) count(p.kind, p.branches.flatMap(b => b.legs));
for (const p of data.approaches.procedures) count('approach', [...p.transitions.flatMap(t => t.legs), ...p.final]);
for (const p of data.approaches.unavailable ?? []) count('approach', p.branches.flatMap(b => b.legs));
for (const kind of Object.keys(sourceCounts)) if (sourceCounts[kind] !== exportedCounts[kind]) throw new Error(`Source/export mismatch: ${kind}`);
if (continuationCounts.source !== continuationCounts.exported) throw new Error('Continuation count mismatch');
const summaries = Object.fromEntries(['departure', 'arrival', 'approach'].map(kind => [kind,
  { procedures: 0, paths: 0, withoutDiagnostics: 0, manualOnly: 0, needsReview: 0, issues: {} }]));
const unusedBranches = [], withoutEntries = [], review = [];
const record = (kind, procedure, selection, preview) => {
  const summary = summaries[kind];
  summary.paths++;
  for (const issue of preview.issues) {
    const key = `${issue.code}:${issue.path}`;
    summary.issues[key] = (summary.issues[key] ?? 0) + 1;
  }
  if (!preview.issues.length) summary.withoutDiagnostics++;
  else if (preview.issues.every(i => i.code === 'manual-termination')) summary.manualOnly++;
  else { summary.needsReview++; review.push({ kind, procedure: procedure.id, selection, issues: preview.issues }); }
};
for (const procedure of data.codedProcedures.procedures) {
  summaries[procedure.kind].procedures++;
  const paths = terminalPaths(procedure);
  const used = new Set(paths.flatMap(p => p.branches));
  for (const branch of procedure.branches) if (!used.has(branch.id)) unusedBranches.push({ procedure: procedure.id, branch: branch.id });
  for (const path of paths) record(procedure.kind, procedure, { branches: path.branches, runway: path.runway },
    resolveApproachLegs(procedure, path.legs, { terminal: true }));
}
for (const procedure of data.approaches.procedures) {
  summaries.approach.procedures++;
  const entries = approachEntryOptions(procedure);
  if (!entries.length) withoutEntries.push(procedure.id);
  for (const entry of entries) record('approach', procedure, entry, approachPreview(procedure, entry.id));
}
const implementation = Object.fromEntries(['coded-terminals.ts', 'approaches.ts', 'approach-path.ts', 'approach-geometry.ts',
  'approach-path-geometry.ts', 'approach-joining.ts'].map(name => [name, hash(readFileSync(new URL(`../packages/domain/src/${name}`, import.meta.url)))]));
const report = { generatedAt: new Date().toISOString(), effectiveDate: data.metadata.effectiveDate, sha256: hash(bytes),
  sourceSha256: hash(sourceText), implementation, sourceCoverage: data.coverage, sourceCounts, exportedCounts, continuationCounts,
  summaries, unusedBranches, withoutEntries, unavailableApproaches: data.approaches.unavailable ?? [], review };
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, review: `${review.length} paths detailed in ${output}` }, null, 2));
