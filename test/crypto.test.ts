import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { Readable } from 'node:stream';
import {
  hashPassword, verifyPassword, deriveFileKey, newSaltHex, encryptFile, decryptStream,
  sealGrant, openGrant, randomToken, sha256Hex,
} from '../src/lib/crypto.ts';

function tmpDir(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crypto-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function readAll(s: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

test('password hash and verify', async () => {
  const h = await hashPassword('hunter2');
  assert.match(h, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
  assert.equal(await verifyPassword('hunter2', h), true);
  assert.equal(await verifyPassword('hunter3', h), false);
  assert.notEqual(h, await hashPassword('hunter2'));
});

test('verifyPassword returns false on malformed input', async () => {
  for (const bad of ['', 'x', 'scrypt$zz$zz', 'scrypt$00$', 'bcrypt$aa$bb', 'scrypt$aa$bb$cc']) {
    assert.equal(await verifyPassword('pw', bad), false);
  }
});

test('deriveFileKey is deterministic per salt', async () => {
  const salt = newSaltHex();
  assert.match(salt, /^[0-9a-f]{32}$/);
  const a = await deriveFileKey('pw', salt);
  assert.equal(a.length, 32);
  assert.deepEqual(a, await deriveFileKey('pw', salt));
  assert.notDeepEqual(a, await deriveFileKey('pw', newSaltHex()));
});

test('encrypt then decrypt round-trips 3 MB', async (t) => {
  const dir = tmpDir(t);
  const src = path.join(dir, 'src.bin');
  const enc = path.join(dir, 'enc.bin');
  const data = crypto.randomBytes(3 * 1024 * 1024);
  fs.writeFileSync(src, data);
  const key = crypto.randomBytes(32);
  await encryptFile(src, enc, key);
  assert.equal(fs.statSync(enc).size, data.length + 28);
  assert.ok(!(await fs.promises.readFile(enc)).subarray(12, 112).equals(data.subarray(0, 100)));
  assert.ok(data.equals(await readAll(await decryptStream(enc, key))));
});

test('wrong key and tampered ciphertext reject', async (t) => {
  const dir = tmpDir(t);
  const src = path.join(dir, 'src.bin');
  const enc = path.join(dir, 'enc.bin');
  fs.writeFileSync(src, crypto.randomBytes(100_000));
  const key = crypto.randomBytes(32);
  await encryptFile(src, enc, key);
  await assert.rejects(readAll(await decryptStream(enc, crypto.randomBytes(32))));
  const buf = fs.readFileSync(enc);
  buf[5000] ^= 1;
  fs.writeFileSync(enc, buf);
  await assert.rejects(readAll(await decryptStream(enc, key)));
});

test('too short file rejects', async (t) => {
  const dir = tmpDir(t);
  const enc = path.join(dir, 'short.bin');
  fs.writeFileSync(enc, Buffer.alloc(20));
  await assert.rejects(decryptStream(enc, crypto.randomBytes(32)));
});

test('empty plaintext round-trips', async (t) => {
  const dir = tmpDir(t);
  const src = path.join(dir, 'e'); const enc = path.join(dir, 'e.enc');
  fs.writeFileSync(src, '');
  const key = crypto.randomBytes(32);
  await encryptFile(src, enc, key);
  assert.equal((await readAll(await decryptStream(enc, key))).length, 0);
});

test('destroying the decrypt stream closes the file', async (t) => {
  const dir = tmpDir(t);
  const src = path.join(dir, 'src.bin');
  const enc = path.join(dir, 'enc.bin');
  fs.writeFileSync(src, crypto.randomBytes(3 * 1024 * 1024));
  const key = crypto.randomBytes(32);
  await encryptFile(src, enc, key);
  const before = fs.readdirSync('/proc/self/fd').length;
  const s = await decryptStream(enc, key);
  await once(s, 'data');
  s.destroy();
  await once(s, 'close');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fs.readdirSync('/proc/self/fd').length, before);
});

test('grants', () => {
  const secret = crypto.randomBytes(32);
  const fileKey = crypto.randomBytes(32);
  const token = sealGrant({ transferId: 't1', fileKey, exp: 2000 }, secret);
  const opened = openGrant(token, secret, 1000);
  assert.equal(opened?.transferId, 't1');
  assert.ok(opened?.fileKey.equals(fileKey));
  assert.equal(openGrant(token, secret, 2000), null);
  assert.equal(openGrant(token, secret, 3000), null);
  const i = 10;
  const tampered = token.slice(0, i) + (token[i] === 'A' ? 'B' : 'A') + token.slice(i + 1);
  assert.equal(openGrant(tampered, secret, 1000), null);
  assert.equal(openGrant(token, crypto.randomBytes(32), 1000), null);
  assert.equal(openGrant('', secret, 1000), null);
  assert.equal(openGrant('abc', secret, 1000), null);
});

test('randomToken and sha256Hex', () => {
  assert.match(randomToken(), /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(randomToken(), randomToken());
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
