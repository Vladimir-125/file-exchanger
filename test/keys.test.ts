import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKey, normalizeKey } from '../src/lib/keys.ts';

test('generateKey produces keys from the alphabet', () => {
  for (let i = 0; i < 1000; i++) {
    assert.match(generateKey(6, () => false), /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
  }
});

test('generateKey retries on collisions and then gives up', () => {
  let calls = 0;
  const key = generateKey(6, () => ++calls < 3);
  assert.equal(calls, 3);
  assert.equal(key.length, 6);
  assert.throws(() => generateKey(6, () => true), /key space exhausted/);
});

test('normalizeKey accepts case and separators', () => {
  assert.equal(normalizeKey('k7px3m', 6), 'K7PX3M');
  assert.equal(normalizeKey(' K7P-X3M ', 6), 'K7PX3M');
});

test('normalizeKey rejects invalid input', () => {
  for (const bad of ['K0PX3M', 'KIPX3M', 'KLPX3M', 'K7PX3', 'K7PX3MM', ['K7PX3M'], null, 5]) {
    assert.equal(normalizeKey(bad, 6), null);
  }
});
