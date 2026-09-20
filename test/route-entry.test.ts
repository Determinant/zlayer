import assert from 'node:assert/strict';
import test from 'node:test';

import {
  backspaceRouteTokenIndex,
  updateRouteEntry,
} from '../src/layers/routes/entry';

test('commits uppercased route text when a delimiter is entered or pasted', () => {
  assert.deepEqual(updateRouteEntry('khw'), { value: 'KHW' });
  assert.deepEqual(updateRouteEntry('khwd '), { value: '', commit: 'KHWD ' });
  assert.deepEqual(updateRouteEntry('ksfo..ksjc'), { value: '', commit: 'KSFO..KSJC' });
  assert.deepEqual(
    updateRouteEntry('khwd sns, ksfo'),
    { value: '', commit: 'KHWD SNS, KSFO' },
  );
});

test('backspace targets only the last token when the entry is empty', () => {
  assert.equal(backspaceRouteTokenIndex('Backspace', '', 3), 2);
  assert.equal(backspaceRouteTokenIndex('Backspace', 'K', 3), undefined);
  assert.equal(backspaceRouteTokenIndex('Delete', '', 3), undefined);
  assert.equal(backspaceRouteTokenIndex('Backspace', '', 0), undefined);
});
