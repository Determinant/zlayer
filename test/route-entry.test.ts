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

test('typing a slash coordinate waits for a route separator, including after backspacing', () => {
  for (const coordinate of ['374529n/1223030w', '3745n/12231w']) {
    for (let length = 0; length <= coordinate.length; length++) {
      const prefix = coordinate.slice(0, length);
      assert.deepEqual(updateRouteEntry(prefix), { value: prefix.toUpperCase() });
    }
    for (const delimiter of [' ', ',', '>', '-', '.', '/']) {
      assert.deepEqual(updateRouteEntry(coordinate + delimiter), { value: '', commit: coordinate.toUpperCase() + delimiter });
    }
  }
  assert.deepEqual(updateRouteEntry('ksfo/ksjc'), { value: '', commit: 'KSFO/KSJC' });
  assert.deepEqual(updateRouteEntry('ksfo 374529n/1223030w ksJC'),
    { value: '', commit: 'KSFO 374529N/1223030W KSJC' });
});
