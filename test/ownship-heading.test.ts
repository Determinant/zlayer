import assert from 'node:assert/strict';
import test from 'node:test';
import { createHeadingConnection } from '../src/layers/ownship/heading';
import { PluginRegistry } from '../src/core/layers/bridge';
import { LayerScope } from '../src/core/layers/scope';
import type { AhrsApi } from '../src/layers/ahrs/public';
import type { HeadingSample } from '../src/core/map/heading';

test('optional heading provider can appear, disappear and return without retaining a revoked lease', () => {
  const connection = createHeadingConnection(), owner = new LayerScope();
  const registry = new PluginRegistry<{ ahrs: AhrsApi }>();
  let leases = 0;
  const registration = registry.registration('ahrs', { publicApi: scope => ({ acquireHeading: scope.command(() => {
    leases++;
    return scope.add(() => { leases--; });
  }) }) });
  registry.forScope(owner).watch('ahrs', (api, scope) => {
    scope.add(() => connection.setProvider(undefined));
    connection.setProvider(api);
  });
  const samples: (HeadingSample | null)[] = [];
  const release = connection.acquireHeading(sample => samples.push(sample));
  assert.equal(leases, 0);
  registration.activate(); assert.equal(leases, 1);
  registration.deactivate(); assert.equal(leases, 0); assert.equal(samples.at(-1), null);
  registration.activate(); assert.equal(leases, 1);
  owner.dispose(); assert.equal(leases, 0);
  release(); release(); registration.deactivate(); assert.equal(leases, 0);
});

test('a consumer can release itself during provider removal without being reattached', () => {
  const connection = createHeadingConnection();
  let acquired = 0, released = 0;
  connection.setProvider({ acquireHeading: () => { acquired++; return () => { released++; }; } });
  let release: (() => void) | undefined;
  release = connection.acquireHeading(() => release?.());
  assert.equal(acquired, 1);
  connection.setProvider(undefined);
  assert.equal(released, 1);
  connection.setProvider({ acquireHeading: () => { acquired++; return () => {}; } });
  assert.equal(acquired, 1);
});

test('provider acquisition and cleanup failures leave optional GPS consumers usable and allow replacement', () => {
  const errors: unknown[] = [], values: (HeadingSample | null)[] = [];
  const connection = createHeadingConnection(error => errors.push(error));
  connection.setProvider({ acquireHeading: () => { throw new Error('provider unavailable'); } });
  const release = connection.acquireHeading(value => values.push(value));
  assert.equal(errors.length, 1);
  connection.setProvider({ acquireHeading: listener => {
    listener({ degrees: 50, time: 1, frame: 1 });
    return () => { throw new Error('cleanup failed'); };
  } });
  assert.equal(values.at(-1)?.degrees, 50);
  connection.setProvider(undefined);
  assert.equal(errors.length, 2);
  assert.equal(values.at(-1), null);
  release();
});

test('late callbacks from a removed heading provider cannot revive assistance', () => {
  const values: (HeadingSample | null)[] = [];
  let notify: (value: HeadingSample) => void = () => {};
  const connection = createHeadingConnection();
  connection.setProvider({ acquireHeading: listener => { notify = listener; return () => {}; } });
  const release = connection.acquireHeading(value => values.push(value));
  connection.setProvider(undefined);
  const count = values.length;
  notify({ degrees: 30, time: 1, frame: 1 });
  assert.equal(values.length, count);
  release();
});
