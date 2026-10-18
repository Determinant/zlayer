import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isNotamSnapshot, isNotamRecord, isNotamSourceIssue, isNotamAirportQuery, isNotamNavaidQuery, isNotamRegionQuery, type NotamEnvironment,
  type NotamRecord, type NotamSourceIssue } from '@zlayer/contracts';
import { createInfoServer } from './info-server/server';
import { createNotamResponder } from './info-server/notams/http';
import { classifyNotamIssue, describeNotamIssue } from './info-server/notams/source-issues';
import { resolveNotamRevision } from './info-server/notams/revision';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
type Entry = { record?: NotamRecord; issue?: NotamSourceIssue };
async function contents(directory: string) {
  const manifest = JSON.parse(await readFile(join(directory, 'current.json'), 'utf8'));
  assert.match(manifest.generation, /^[a-f0-9]{64}$/, 'Invalid frozen generation identity');
  const path = join(directory, manifest.generation + '.ndjson'), size = (await lstat(path)).size;
  assert.ok(size === manifest.bytes && size <= 256 * 1024 * 1024, 'Frozen generation size mismatch');
  const bytes = await readFile(path);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.generation, 'Frozen generation checksum mismatch');
  const entries = new Map<string, Entry>();
  for (const line of bytes.toString().trimEnd().split('\n').filter(Boolean)) {
    const value = JSON.parse(line);
    if (value.kind === 'issue') { assert.ok(isNotamSourceIssue(value.issue)); entries.set(value.issue.id, { issue: value.issue }); }
    else { assert.ok(isNotamRecord(value)); entries.set(value.id, { record: value }); }
  }
  return { manifest, entries };
}
async function rejectLinks(path: string): Promise<void> {
  const info = await lstat(path);
  assert.ok(info.isFile() || info.isDirectory(), 'Frozen state must contain only regular files and directories');
  if (info.isDirectory()) for (const name of await readdir(path)) await rejectLinks(join(path, name));
}
async function journalHashes(directory: string) {
  const result: Record<string, string> = {};
  // Include provisioning and diagnostic history alongside the admission journal.
  for (const name of (await readdir(directory)).filter(name => name === 'provisioned' || name.endsWith('.json') &&
    !['current.json', 'previous.json', 'candidate.json'].includes(name)).sort())
    result[name] = createHash('sha256').update(await readFile(join(directory, name))).digest('hex');
  return result;
}
function queryPaths(entries: Iterable<Entry>) {
  const paths = new Set<string>();
  for (const { record, issue } of entries) {
    for (const code of (record ?? issue)!.locations) {
      if (isNotamAirportQuery({ faaId: code })) paths.add('/api/notams/airports?faaId=' + code);
      if (isNotamNavaidQuery({ navaidId: code })) paths.add('/api/notams/navaids?navaidId=' + code);
      if (isNotamRegionQuery({ artccId: code })) paths.add('/api/notams/regions?artccId=' + code);
    }
    for (const code of (record ?? issue)!.icaoLocations) {
      if (isNotamAirportQuery({ icaoId: code })) paths.add('/api/notams/airports?icaoId=' + code);
      if (isNotamRegionQuery({ firId: code })) paths.add('/api/notams/regions?firId=' + code);
    }
  }
  return [...paths].sort();
}
type State = Awaited<ReturnType<typeof restoreCopy>>;
async function restoreCopy(input: string, environment: NotamEnvironment, at: number, factory: typeof createInfoServer) {
  const workspace = await mkdtemp(join(tmpdir(), 'notam-replay-'));
  const directory = join(workspace, 'notams'), state = join(directory, environment);
  let app: Awaited<ReturnType<typeof createInfoServer>> | undefined, requests = 0;
  try {
    await cp(input, state, { recursive: true, filter: source => !source.endsWith('.tmp') });
    const before = await contents(state), journals = await journalHashes(state);
    app = await factory({ directory: join(workspace, 'weather'), startUpdates: false, now: () => at,
      notams: { enabled: true, environment, directory, credentials: { clientId: 'offline', clientSecret: 'offline' } },
      fetch: async () => { requests++; throw new Error('Replay prohibits source acquisition'); } });
    await app.notams.restore();
    const after = await contents(state), feed = app.notams.status;
    assert.ok(feed.generation !== null, 'Copied checkpoint did not restore');
    for (const field of ['checkedAt', 'watermark', 'fullSyncAt']) assert.equal(feed[field as keyof typeof feed], before.manifest[field], field);
    for (const field of ['baselineAt', 'complete', 'incompleteReason']) assert.deepEqual(after.manifest[field], before.manifest[field], field);
    assert.deepEqual(await journalHashes(state), journals, 'Replay changed request admission or diagnostic history');
    const responder = createNotamResponder(app.notams);
    const paths = queryPaths([...before.entries.values(), ...after.entries.values()]);
    const queries = new Map<string, string>();
    const impacts = new Map<string, { affectedQueries: string[]; usableQueries: string[]; historicalQueries: string[] }>();
    for (const [id, entry] of after.entries) if (entry.issue)
      impacts.set(id, { affectedQueries: [], usableQueries: [], historicalQueries: [] });
    for (const path of paths) {
      const response = responder.read(path, undefined), snapshot = JSON.parse(response.body.toString());
      if (response.status !== 200) {
        assert.equal(response.status, 503); assert.equal(snapshot.error, 'airport-size-limit');
        queries.set(path, digest({ status: response.status, error: snapshot.error })); continue;
      }
      assert.ok(isNotamSnapshot(snapshot), 'Invalid replay response: ' + path);
      for (const issue of snapshot.issues ?? []) impacts.get(issue.id)?.affectedQueries.push(path);
      for (const issue of snapshot.historicalIssues ?? []) impacts.get(issue.id)?.historicalQueries.push(path);
      for (const record of snapshot.records) impacts.get(record.id)?.usableQueries.push(path);
      // Source status is checked separately; this captures delivered content and
      // association membership, including changes to historical classification.
      const { feed: _feed, ...content } = snapshot; queries.set(path, digest(content));
    }
    assert.equal(requests, 0);
    return { entries: after.entries, feed, queries, impacts, issues: app.notams.sourceIssues, sourceRequests: requests };
  } finally { await app?.close(); await rm(workspace, { recursive: true, force: true }); }
}

/** Input is a frozen environment checkpoint directory. Every restore operates
 * on a private copy; live files, locks and quota journals are never opened by a service. */
export async function replayNotams(options: { directory: string; environment: NotamEnvironment; at: number; baselineServer?: string }) {
  const input = resolve(options.directory);
  await rejectLinks(input);
  const original = await contents(input), journals = await journalHashes(input);
  const candidate = await restoreCopy(input, options.environment, options.at, createInfoServer);
  let baseline: State | undefined;
  if (options.baselineServer) {
    const module = await import(pathToFileURL(resolve(options.baselineServer)).href);
    assert.equal(typeof module.createInfoServer, 'function', 'Baseline must export createInfoServer');
    baseline = await restoreCopy(input, options.environment, options.at, module.createInfoServer);
  }
  const before = baseline?.entries ?? original.entries;
  const changes = [...new Set([...before.keys(), ...candidate.entries.keys()])].sort().flatMap(id => {
    const previous = before.get(id), next = candidate.entries.get(id);
    if (digest(previous) === digest(next)) return [];
    const decision = previous?.issue ? resolveNotamRevision(previous.issue.variants) : undefined;
    return [{ id, before: digest(previous), after: digest(next),
      from: previous?.issue ? 'issue' : previous ? 'record' : 'absent', to: next?.issue ? 'issue' : next ? 'record' : 'absent',
      proofs: decision?.kind === 'resolved' ? decision.proofs : [],
      remainingIssue: next?.issue ? describeNotamIssue(next.issue, classifyNotamIssue(next.issue, options.at)) : null }];
  });
  const queryChanges = baseline ? [...new Set([...baseline.queries.keys(), ...candidate.queries.keys()])].sort()
    .filter(path => baseline.queries.get(path) !== candidate.queries.get(path))
    .map(path => ({ path, before: baseline.queries.get(path) ?? null, after: candidate.queries.get(path) ?? null })) : [];
  const impactChanges = baseline ? [...new Set([...baseline.impacts.keys(), ...candidate.impacts.keys()])].sort()
    .filter(id => digest(baseline.impacts.get(id)) !== digest(candidate.impacts.get(id)))
    .map(id => ({ id, before: baseline.impacts.get(id) ?? null, after: candidate.impacts.get(id) ?? null })) : [];
  const healthImpact = (state: State) => ({ state: state.feed.state, error: state.feed.error,
    collectionContinuity: state.feed.collectionContinuity ?? state.feed.continuity, continuity: state.feed.continuity,
    unresolvedRecords: state.feed.unresolvedRecords ?? 0, blockingRecords: state.feed.blockingRecords ?? state.feed.unresolvedRecords ?? 0,
    historicalIssues: state.feed.historicalIssues ?? 0, unscopedRecords: state.feed.unscopedRecords ?? 0 });
  const healthChanges = baseline && digest(healthImpact(baseline)) !== digest(healthImpact(candidate))
    ? { before: healthImpact(baseline), after: healthImpact(candidate) } : null;
  assert.deepEqual(await contents(input), original, 'Frozen input changed during replay');
  assert.deepEqual(await journalHashes(input), journals, 'Frozen input journals changed during replay');
  return { at: options.at, environment: options.environment, baselineCompared: !!baseline,
    sourceRequests: candidate.sourceRequests, admissionUnchanged: true, sourceClocksUnchanged: true,
    changes, queryChanges, impactChanges, healthChanges, baselineFeed: baseline?.feed ?? null, candidateFeed: candidate.feed,
    baselineIssues: baseline?.issues ?? null, candidateIssues: candidate.issues, queriesChecked: candidate.queries.size };
}

export function assertReviewedNotamReplay(report: Awaited<ReturnType<typeof replayNotams>>, review: Record<string, unknown>) {
  assert.ok(review && typeof review === 'object' && !Array.isArray(review), 'Invalid reviewed replay report');
  assert.equal(report.baselineCompared, true, 'Release gate requires a baseline server');
  for (const key of ['at', 'environment', 'changes', 'queryChanges', 'impactChanges', 'healthChanges', 'baselineFeed', 'candidateFeed', 'baselineIssues', 'candidateIssues'] as const)
    assert.deepEqual(report[key], review[key], 'Unreviewed replay difference: ' + key);
}

if (import.meta.main) {
  try {
    const [directory, environment, ...args] = process.argv.slice(2);
    assert.ok(directory && (environment === 'staging' || environment === 'production'), 'Supply a frozen checkpoint directory and staging|production');
    assert.ok(args.every(arg => arg === '--report-only' || /^(--at|--baseline|--output|--expect)=.+$/.test(arg)), 'Unknown replay option');
    const option = (name: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
    const at = option('at') ? Date.parse(option('at')!) : Date.now(); assert.ok(Number.isFinite(at), 'Invalid replay time');
    const expected = option('expect'), output = option('output');
    const review = expected ? JSON.parse(await readFile(expected, 'utf8')) : undefined;
    if (output) {
      assert.ok(!expected || resolve(output) !== resolve(expected), 'Report output must not overwrite its review');
      const input = await realpath(directory), target = join(await realpath(dirname(resolve(output))), basename(output));
      const path = relative(input, target);
      assert.ok(path === '..' || path.startsWith('..' + sep) || isAbsolute(path), 'Report output must be outside the frozen input');
    }
    const baselineServer = option('baseline');
    const report = await replayNotams({ directory, environment, at, ...(baselineServer ? { baselineServer } : {}) });
    if (output) await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    if (expected) assertReviewedNotamReplay(report, review);
    console.log(JSON.stringify({ at: report.at, baselineCompared: report.baselineCompared, queriesChecked: report.queriesChecked,
      recordChanges: report.changes.length, queryChanges: report.queryChanges.length, impactChanges: report.impactChanges.length,
      healthChanged: report.healthChanges !== null, sourceRequests: report.sourceRequests, admissionUnchanged: report.admissionUnchanged,
      sourceClocksUnchanged: report.sourceClocksUnchanged, reviewed: !!expected, output: output ?? null }));
    assert.ok(expected || args.includes('--report-only'), 'Review the output report, then rerun with --baseline and --expect pointing to the reviewed report');
  } catch (cause) { console.error(cause instanceof Error ? cause.message : cause); process.exitCode = 1; }
}
