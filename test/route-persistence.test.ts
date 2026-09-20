import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { createRouteResolver, routeDraftFromText } from '@zlayer/domain';
import { draftSnapshot } from './helpers/route-draft';
import { Hooks, hookModule } from './helpers/hooks';

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
  render()[1](draft); render();
  assert.deepEqual(restart()[0], draft);
  const reloadedPlan = createRouteResolver([])(restart()[0]);
  assert.equal(reloadedPlan.legs.length, 2);
  assert.deepEqual(reloadedPlan.issues, []);
  restart()[1]({ entries: [] }); render();
  assert.deepEqual(restart()[0], { entries: [] });
  for (const value of ['{', '[]', 'null', '{"version":3,"entries":[]}',
    JSON.stringify({ version: 2, entries: [{ id: 'x', text: 'SFO SNS' }] }),
    JSON.stringify({ version: 2, entries: [{ id: 'x', text: 'SFO' }, { id: 'x', text: 'SNS' }] })]) {
    saved = value;
    assert.deepEqual(restart()[0], { entries: [] });
  }
  storage.getItem = () => { throw new Error('denied'); };
  storage.setItem = () => { throw new Error('full'); };
  restart()[1](draft);
  assert.deepEqual(render()[0], draft);
});
