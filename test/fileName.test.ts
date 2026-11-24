import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeDisplayName } from '../src/lib/fileName.ts';

test('safeDisplayName', () => {
  assert.equal(safeDisplayName('../../etc/passwd'), 'passwd');
  assert.equal(safeDisplayName('..\\..\\win.ini'), 'win.ini');
  assert.equal(safeDisplayName('.hidden'), 'hidden');
  assert.equal(safeDisplayName('a<b>:c?.txt'), 'a_b__c_.txt');
  assert.equal(safeDisplayName('тест.txt'), 'тест.txt');
  assert.equal(safeDisplayName(''), 'file');
  assert.equal(safeDisplayName('..'), 'file');
  assert.equal(safeDisplayName(42), 'file');
  assert.equal(safeDisplayName('a\u0000b\nc'), 'a_b_c');
  assert.equal(safeDisplayName('x'.repeat(300)).length, 200);
});
