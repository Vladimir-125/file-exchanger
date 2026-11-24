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

test('safeDisplayName removes bidi overrides and C1 controls', () => {
  const spoofed = safeDisplayName('invoice\u202Efdp.exe');
  assert.ok(!spoofed.includes('\u202E'));
  assert.equal(spoofed, 'invoice_fdp.exe');
  for (const c of ['\u0080', '\u009f', '\u200e', '\u200f', '\u202a', '\u202d', '\u2066', '\u2069']) {
    assert.equal(safeDisplayName(`a${c}b`), 'a_b', `U+${c.codePointAt(0)!.toString(16)}`);
  }
});

test('safeDisplayName: whitespace-only names and surrogate pairs at the length limit', () => {
  for (const name of [' ', '   ', '\u00a0 \u3000']) assert.equal(safeDisplayName(name), 'file');
  const cut = safeDisplayName('a' + '\u{1F600}'.repeat(300));
  assert.equal(Array.from(cut).length, 200);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(cut), 'no lone surrogate');
});
