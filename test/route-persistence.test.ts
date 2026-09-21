import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { createRouteResolver, routeDraftFromText } from '@zlayer/domain';
import { draftSnapshot } from './helpers/route-draft';
import { Hooks, hookModule } from './helpers/hooks';
import { replaceRouteText, setRouteApproach } from '../src/layers/routes/draft';

const loader = registerHooks({ resolve(specifier, context, next) {
  return specifier === 'react' ? { url: hookModule, shortCircuit: true } : next(specifier, context);
} });
const { useRouteDraft } = await import('../src/layers/routes/use-draft');
loader.deregister();

test('legacy drafts migrate once; entry identity and pins survive reload and denied storage remains editable', t => {
  let saved: string | null = JSON.stringify({ version: 1, input: 'kpao DCT sns..kmry',
    pinnedFeatureIds: { 0: 'airport:KPAO', 1: 'navaid:SNS', '-1': 'bad', '02': 'bad', 4: 'bad' } });
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value; } };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  t.after(() => original ? Object.defineProperty(globalThis, 'localStorage', original) : Reflect.deleteProperty(globalThis, 'localStorage'));
  let hooks = new Hooks();
  const render = () => { Object.assign(globalThis, { testHooks: hooks }); return hooks.render(useRouteDraft); };
  const restart = () => { hooks.unmount(); hooks = new Hooks(); return render(); };
  const migrated = render()[0];
  assert.deepEqual(draftSnapshot(migrated), { input: 'KPAO SNS KMRY', pinnedFeatureIds: { 0: 'airport:KPAO', 1: 'navaid:SNS' } });
  assert.equal(JSON.parse(saved!).version, 2);
  assert.equal(new Set(migrated.entries.map(entry => entry.id)).size, 3);
  assert.deepEqual(restart()[0], migrated, 'IDs persist; migration does not run on every reload');
  const draft = routeDraftFromText('370000N1220000W 371500N1223000W 380000N1230000W');
  render()[1](draft);
  assert.deepEqual(restart()[0], draft);
  const reloadedPlan = createRouteResolver([])(restart()[0]);
  assert.equal(reloadedPlan.legs.length, 2);
  assert.deepEqual(reloadedPlan.issues, []);
  restart()[1]({ entries: [] });
  assert.deepEqual(restart()[0], { entries: [] });
  for (const value of ['{', '[]', 'null', '{"version":3,"entries":[]}',
    JSON.stringify({ version: 2, entries: [{ id: 'x', text: 'SFO SNS' }] }),
    JSON.stringify({ version: 2, entries: [{ id: 'x', text: 'SFO' }, { id: 'x', text: 'SNS' }] })]) {
    saved = value;
    assert.deepEqual(restart()[0], { entries: [] });
    assert.equal(saved, value, 'mounting a fallback never overwrites corrupt or newer records');
  }
  storage.getItem = () => { throw new Error('denied'); };
  storage.setItem = () => { throw new Error('full'); };
  restart()[1](draft);
  assert.deepEqual(render()[0], draft);
});

test('approach selection, switching and removal persist immediately while malformed attachments retain their airport', t => {
  let saved: string | null = null;
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: () => saved, setItem: (_key: string, value: string) => { saved = value; },
  } });
  t.after(() => original ? Object.defineProperty(globalThis, 'localStorage', original) : Reflect.deleteProperty(globalThis, 'localStorage'));
  let hooks = new Hooks();
  const render = () => { Object.assign(globalThis, { testHooks: hooks }); return hooks.render(useRouteDraft); };
  const restart = () => { hooks.unmount(); hooks = new Hooks(); return render(); };
  const draft = routeDraftFromText('KSFO KSJC', { 1: 'airport:KSJC' });
  render()[1](draft);
  const approach = { kind: 'approach' as const, source: 'chart' as const, airportId: 'KSJC', procedureId: 'rnav', name: 'RNAV (GPS) RWY 30L', cycle: '2609',
    entry: { routeId: 'KSJC:R30L', transitionId: 'transition:SILVA', name: 'SILVA', effectiveDate: '2026-09-03' } };
  render()[1](current => setRouteApproach(current, current.entries[1]!, approach));
  assert.deepEqual(JSON.parse(saved!).entries[1].approach, approach);
  const attached = restart()[0];
  assert.deepEqual(attached.entries[1]!.approach, approach);
  const alternate = { ...approach, procedureId: 'ils', name: 'ILS RWY 30L' };
  render()[1](current => setRouteApproach(current, current.entries[1]!, alternate));
  assert.deepEqual(JSON.parse(saved!).entries[1].approach, alternate);
  assert.deepEqual(restart()[0].entries[1]!.approach, alternate);
  render()[1](current => setRouteApproach(current, current.entries[1]!, undefined));
  assert.equal(JSON.parse(saved!).entries[1].approach, undefined);
  assert.equal(restart()[0].entries[1]!.approach, undefined);
  render()[1](current => setRouteApproach(current, current.entries[1]!, alternate));
  render()[1](current => replaceRouteText(current, current.entries[1]!.id, 'KSFO'));
  assert.equal(render()[0].entries[1]!.approach, undefined);
  assert.equal(restart()[0].entries[1]!.approach, undefined);
  assert.equal(render()[0].entries[1]!.text, 'KSFO');
  for (const invalid of [null, 'rnav', {}, { ...approach, cycle: 2609 }, { ...approach, name: '' }]) {
    saved = JSON.stringify({ version: 2, entries: [{ ...draft.entries[1], approach: invalid }] });
    assert.deepEqual(restart()[0].entries, [draft.entries[1]]);
  }
});
