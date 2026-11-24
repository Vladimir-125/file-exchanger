import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.ts';

const SECRET = 'a'.repeat(64);
const cfg = (env: Record<string, string | undefined> = {}) =>
  loadConfig({ APP_SECRET: SECRET, ...env });

test('defaults', () => {
  const c = cfg();
  assert.equal(c.port, 3000);
  assert.equal(c.keyLength, 6);
  assert.equal(c.transferTtlMs, 24 * 3600e3);
  assert.equal(c.chunkBytes, 50 * 2 ** 20);
  assert.equal(c.maxFileBytes, 2000 * 2 ** 20);
  assert.equal(c.maxTransferBytes, 4000 * 2 ** 20);
  assert.equal(c.maxFilesPerTransfer, 20);
  assert.equal(c.liveKeyTtlMs, 600e3);
  assert.equal(c.uploadAbandonMs, 3600e3);
  assert.equal(c.smtpUrl, null);
  assert.equal(c.baseUrl, '');
  assert.equal(c.cookieSecure, false);
  assert.equal(c.storageCapBytes, 50 * 2 ** 30);
  assert.deepEqual(c.iceServers, [{ urls: 'stun:stun.l.google.com:19302' }]);
  assert.equal(c.appSecret.length, 32);
  assert.ok(c.dataDir.startsWith('/'));
});

test('missing APP_SECRET generates a random 32-byte secret and warns', () => {
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (m: string) => void warnings.push(m);
  try {
    const a = loadConfig({});
    const b = loadConfig({});
    assert.equal(a.appSecret.length, 32);
    assert.notDeepEqual(a.appSecret, b.appSecret);
  } finally {
    console.warn = orig;
  }
  assert.equal(warnings.length, 2);
});

test('STORAGE_CAP_GB accepts decimals', () => {
  assert.equal(cfg({ STORAGE_CAP_GB: '0.003' }).storageCapBytes, Math.floor(0.003 * 2 ** 30));
});

test('COOKIE_SECURE', () => {
  assert.equal(cfg({ COOKIE_SECURE: 'true' }).cookieSecure, true);
  assert.equal(cfg({ COOKIE_SECURE: '1' }).cookieSecure, true);
  assert.equal(cfg({ COOKIE_SECURE: 'no' }).cookieSecure, false);
});

test('TRUST_PROXY parsing', () => {
  for (const v of ['', 'false', '0']) assert.equal(cfg({ TRUST_PROXY: v }).trustProxy, false);
  assert.equal(cfg({ TRUST_PROXY: 'true' }).trustProxy, 1);
  assert.equal(cfg({ TRUST_PROXY: '2' }).trustProxy, 2);
  assert.equal(cfg({ TRUST_PROXY: 'loopback' }).trustProxy, 'loopback');
});

test('TURN server is appended to iceServers', () => {
  const c = cfg({ TURN_URL: 'turn:x:3478', TURN_USERNAME: 'u', TURN_CREDENTIAL: 'p' });
  assert.deepEqual(c.iceServers[1], { urls: 'turn:x:3478', username: 'u', credential: 'p' });
  assert.equal(c.iceServers.length, 2);
});

test('APP_SECRET validation', () => {
  assert.deepEqual(cfg().appSecret, Buffer.from(SECRET, 'hex'));
  assert.throws(() => loadConfig({ APP_SECRET: 'short' }));
});

test('an empty APP_SECRET (copied .env.example) counts as unset', () => {
  const orig = console.warn;
  console.warn = () => {};
  try {
    assert.equal(loadConfig({ APP_SECRET: '' }).appSecret.length, 32);
  } finally {
    console.warn = orig;
  }
});

test('limits are validated', () => {
  assert.throws(() => cfg({ KEY_LENGTH: '3' }));
  assert.throws(() => cfg({ KEY_LENGTH: '13' }));
  assert.equal(cfg({ KEY_LENGTH: '8' }).keyLength, 8);
  assert.throws(() => cfg({ CHUNK_MB: '200' }));
});
