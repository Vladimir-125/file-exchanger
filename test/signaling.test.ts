import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import WebSocket from 'ws';
import { makeTestApp, postJson, type TestApp } from './helpers.ts';

const KEY_RE = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/;
const WAIT_MS = 2000;

type Msg = { type: string; [k: string]: unknown };

/** A ws client that queues every message and lets a test await the next one of a type. */
type Client = {
  ws: WebSocket;
  received: Msg[];
  send(msg: unknown): void;
  next(type: string): Promise<Msg>;
  closed: Promise<void>;
};

function connect(t: TestContext, app: TestApp, headers: Record<string, string> = {}, path = '/ws'): Promise<Client> {
  const ws = new WebSocket(app.base.replace('http', 'ws') + path, { headers });
  const received: Msg[] = [];
  const queue: Msg[] = [];
  const waiters: { type: string; resolve: (m: Msg) => void }[] = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data)) as Msg;
    received.push(msg);
    const i = waiters.findIndex((w) => w.type === msg.type);
    if (i >= 0) waiters.splice(i, 1)[0]!.resolve(msg);
    else queue.push(msg);
  });
  const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
  t.after(() => ws.terminate());
  const client: Client = {
    ws,
    received,
    closed,
    send: (msg) => ws.send(typeof msg === 'string' || Buffer.isBuffer(msg) ? msg : JSON.stringify(msg)),
    next(type) {
      const i = queue.findIndex((m) => m.type === type);
      if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]!);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for "${type}"`)), WAIT_MS);
        waiters.push({ type, resolve: (m) => (clearTimeout(timer), resolve(m)) });
      });
    },
  };
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(client));
    ws.once('error', reject);
  });
}

/** Round-trips a bad message: every message the server queued before it has then arrived. */
async function flush(c: Client) {
  c.send('probe');
  assert.equal((await c.next('error')).code, 'bad_message');
}

async function app(t: TestContext, opts: Parameters<typeof makeTestApp>[0] = {}) {
  const a = await makeTestApp(opts);
  t.after(() => a.close());
  return a;
}

async function host(t: TestContext, a: TestApp) {
  const sender = await connect(t, a);
  sender.send({ type: 'host' });
  const hosted = await sender.next('hosted');
  return { sender, key: hosted.key as string, liveToken: hosted.liveToken as string, hosted };
}

/** Uploads one small file and completes it with the given body; returns the response. */
async function upload(a: TestApp, completeBody: unknown = {}) {
  const res = await fetch(`${a.base}/api/transfers`, postJson({ files: [{ name: 'a.txt', size: 5 }] }));
  assert.equal(res.status, 201);
  const c = (await res.json()) as { transferId: string; uploadToken: string; files: { fileId: string }[] };
  const put = await fetch(`${a.base}/api/transfers/${c.transferId}/files/${c.files[0]!.fileId}/chunks/0`, {
    method: 'PUT',
    headers: { 'x-upload-token': c.uploadToken, 'content-type': 'application/octet-stream' },
    body: 'hello',
  });
  assert.equal(put.status, 204);
  return fetch(`${a.base}/api/transfers/${c.transferId}/complete`, {
    method: 'POST',
    headers: { 'x-upload-token': c.uploadToken, 'content-type': 'application/json' },
    body: JSON.stringify(completeBody),
  });
}

test('host, join and relay signals both ways', async (t) => {
  const a = await app(t);
  const { sender, key, liveToken, hosted } = await host(t, a);
  assert.match(key, KEY_RE);
  assert.equal(typeof liveToken, 'string');
  assert.ok(liveToken.length >= 32);
  assert.ok(typeof hosted.expiresAt === 'number' && hosted.expiresAt > Date.now());
  assert.deepEqual(hosted.iceServers, a.deps.config.iceServers);
  assert.equal(a.signaling.isLive(key), true);

  const receiver = await connect(t, a);
  receiver.send({ type: 'join', key: key.toLowerCase() });
  const joined = await receiver.next('joined');
  assert.deepEqual(joined.iceServers, a.deps.config.iceServers);
  await sender.next('peer-joined');

  const offer = { sdp: { type: 'offer', sdp: 'v=0\r\n' }, n: [1, 2, 3] };
  sender.send({ type: 'signal', data: offer });
  assert.deepEqual(await receiver.next('signal'), { type: 'signal', data: offer });
  const ice = { candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host' };
  receiver.send({ type: 'signal', data: ice });
  assert.deepEqual(await sender.next('signal'), { type: 'signal', data: ice });
});

test('join: busy, not-found and not-live', async (t) => {
  const a = await app(t);
  const { key } = await host(t, a);
  const receiver = await connect(t, a);
  receiver.send({ type: 'join', key });
  await receiver.next('joined');

  const third = await connect(t, a);
  third.send({ type: 'join', key });
  await third.next('busy');
  third.send({ type: 'join', key: key === '222222' ? '333333' : '222222' });
  await third.next('not-found');
  third.send({ type: 'join', key: 'not a key' });
  await third.next('not-found');

  const res = await upload(a);
  assert.equal(res.status, 200);
  const stored = ((await res.json()) as { key: string }).key;
  third.send({ type: 'join', key: stored.toLowerCase() });
  await third.next('not-live');
});

test('sender leaving tells the receiver and frees the key', async (t) => {
  const a = await app(t);
  const { sender, key } = await host(t, a);
  const receiver = await connect(t, a);
  receiver.send({ type: 'join', key });
  await receiver.next('joined');

  sender.ws.close();
  await receiver.next('peer-left');
  assert.equal(a.signaling.isLive(key), false);
  receiver.send({ type: 'join', key });
  await receiver.next('not-found');
});

test('receiver leaving keeps the key live for a new receiver', async (t) => {
  const a = await app(t);
  const { sender, key } = await host(t, a);
  const first = await connect(t, a);
  first.send({ type: 'join', key });
  await first.next('joined');
  await sender.next('peer-joined');

  first.ws.close();
  await sender.next('peer-left');
  assert.equal(a.signaling.isLive(key), true);
  const second = await connect(t, a);
  second.send({ type: 'join', key });
  await second.next('joined');
  await sender.next('peer-joined');
});

test('an unpaired live key expires after the TTL unless claimed', async (t) => {
  let clock = Date.now();
  const a = await app(t, { now: () => clock });
  const { sender, key, hosted } = await host(t, a);
  assert.equal(hosted.expiresAt, clock + 10 * 60_000);
  const claimed = await host(t, a);
  assert.equal(a.signaling.claimLiveKey(claimed.key, claimed.liveToken), true);

  clock += 10 * 60_000 - 1;
  a.signaling.sweep();
  assert.equal(a.signaling.isLive(key), true);

  clock += 1;
  a.signaling.sweep();
  await sender.next('expired');
  await sender.closed;
  assert.equal(a.signaling.isLive(key), false);
  assert.equal(a.signaling.isLive(claimed.key), true, 'a claimed key does not expire');
});

test('a paired key does not expire, so a long fallback upload keeps it', async (t) => {
  let clock = Date.now();
  const a = await app(t, { now: () => clock });
  const { sender, key, liveToken } = await host(t, a);
  const receiver = await connect(t, a);
  receiver.send({ type: 'join', key });
  await receiver.next('joined');

  clock += 30 * 60_000;
  a.signaling.sweep();
  await flush(sender);
  await flush(receiver);
  assert.ok(![...sender.received, ...receiver.received].some((m) => m.type === 'expired'));
  assert.equal(a.signaling.isLive(key), true);

  const res = await upload(a, { liveKey: key, liveToken });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { key: string }).key, key);
  assert.deepEqual(await receiver.next('switch-to-download'), { type: 'switch-to-download', key });
});

test('the TTL restarts when the receiver leaves', async (t) => {
  let clock = Date.now();
  const a = await app(t, { now: () => clock });
  const { sender, key } = await host(t, a);
  const receiver = await connect(t, a);
  receiver.send({ type: 'join', key });
  await receiver.next('joined');
  clock += 30 * 60_000;

  receiver.ws.close();
  assert.deepEqual(await sender.next('peer-left'), { type: 'peer-left', expiresAt: clock + 10 * 60_000 });
  clock += 10 * 60_000 - 1000;
  a.signaling.sweep();
  assert.equal(a.signaling.isLive(key), true);

  clock += 2000;
  a.signaling.sweep();
  await sender.next('expired');
  assert.equal(a.signaling.isLive(key), false);
});

test('the heartbeat drops a sender that stops answering pings', async (t) => {
  const a = await app(t, { heartbeatMs: 200 });
  const { sender, key } = await host(t, a);
  const receiver = await connect(t, a);
  receiver.send({ type: 'join', key });
  await receiver.next('joined');

  (sender.ws as unknown as { _socket: { pause(): void } })._socket.pause(); // pings go unanswered
  await receiver.next('peer-left');
  assert.equal(a.signaling.isLive(key), false);
  assert.equal(receiver.ws.readyState, receiver.ws.OPEN, 'the live receiver is kept');
});

test('an expired key is also caught on the next message', async (t) => {
  let clock = Date.now();
  const a = await app(t, { now: () => clock });
  const { sender, key } = await host(t, a);
  clock += 10 * 60_000;
  const other = await connect(t, a);
  other.send({ type: 'join', key });
  await other.next('not-found');
  await sender.next('expired');
});

test('fallback upload with the live token takes the live key and switches the receiver', async (t) => {
  const a = await app(t);
  const { sender, key, liveToken } = await host(t, a);
  const receiver = await connect(t, a);
  receiver.send({ type: 'join', key: key.toLowerCase() });
  await receiver.next('joined');

  const res = await upload(a, { liveKey: key.toLowerCase(), liveToken });
  assert.equal(res.status, 200);
  const ready = (await res.json()) as { key: string; url: string };
  assert.equal(ready.key, key);
  assert.ok(ready.url.endsWith(`/${key}`));
  assert.deepEqual(await receiver.next('switch-to-download'), { type: 'switch-to-download', key });
  await Promise.all([sender.closed, receiver.closed]);
  assert.equal(a.signaling.isLive(key), false);
  assert.equal((await fetch(`${a.base}/api/transfers/${key}`)).status, 200);

  // the key now belongs to the stored transfer
  const late = await connect(t, a);
  late.send({ type: 'join', key });
  await late.next('not-live');
});

test('fallback with a wrong live token gets a new key and the receiver hears nothing', async (t) => {
  const a = await app(t);
  const { key, liveToken } = await host(t, a);
  const receiver = await connect(t, a);
  receiver.send({ type: 'join', key });
  await receiver.next('joined');

  const res = await upload(a, { liveKey: key, liveToken: liveToken.slice(0, -1) + (liveToken.endsWith('A') ? 'B' : 'A') });
  assert.equal(res.status, 200);
  const ready = (await res.json()) as { key: string };
  assert.match(ready.key, KEY_RE);
  assert.notEqual(ready.key, key);
  await flush(receiver);
  assert.ok(!receiver.received.some((m) => m.type === 'switch-to-download'));
  assert.equal(a.signaling.isLive(key), true);

  // a token for a key that is not live is ignored as well
  const other = await upload(a, { liveKey: '222222', liveToken });
  assert.equal(other.status, 200);
  assert.match(((await other.json()) as { key: string }).key, KEY_RE);
});

test('the 31st host from one IP within an hour is rate limited', async (t) => {
  let clock = Date.now();
  const a = await app(t, { now: () => clock, rateLimits: { ws: 30 } });
  for (let i = 0; i < 30; i++) await host(t, a);
  const c = await connect(t, a);
  c.send({ type: 'host' });
  assert.equal((await c.next('error')).code, 'rate_limited');

  clock += 3600_000;
  c.send({ type: 'host' });
  await c.next('hosted');
});

test('the host limit is per client IP from X-Forwarded-For when TRUST_PROXY is set', async (t) => {
  const a = await app(t, { configEnv: { TRUST_PROXY: '1', BASE_URL: 'http://files.test' }, rateLimits: { ws: 1 } });
  const one = { 'x-forwarded-for': '198.51.100.1' };
  const two = { 'x-forwarded-for': '198.51.100.2' };
  (await connect(t, a, one)).send({ type: 'host' });
  const c1 = await connect(t, a, one);
  c1.send({ type: 'host' });
  assert.equal((await c1.next('error')).code, 'rate_limited');
  const c2 = await connect(t, a, two);
  c2.send({ type: 'host' });
  await c2.next('hosted');
});

test('without TRUST_PROXY, X-Forwarded-For is ignored', async (t) => {
  const a = await app(t, { rateLimits: { ws: 1 } });
  await host(t, a);
  const c = await connect(t, a, { 'x-forwarded-for': '198.51.100.9' });
  c.send({ type: 'host' });
  assert.equal((await c.next('error')).code, 'rate_limited');
});

test('one role per socket; signals from an unpaired socket are dropped', async (t) => {
  const a = await app(t);
  const { sender, key } = await host(t, a);
  sender.send({ type: 'host' });
  assert.equal((await sender.next('error')).code, 'bad_state');
  sender.send({ type: 'join', key });
  assert.equal((await sender.next('error')).code, 'bad_state');
  sender.send({ type: 'signal', data: 'nobody' });
  await flush(sender);
  assert.deepEqual(
    sender.received.map((m) => m.type),
    ['hosted', 'error', 'error', 'error'],
  );

  const receiver = await connect(t, a);
  receiver.send({ type: 'signal', data: 'nobody' });
  receiver.send({ type: 'join', key });
  await receiver.next('joined');
  receiver.send({ type: 'host' });
  assert.equal((await receiver.next('error')).code, 'bad_state');
  await sender.next('peer-joined');
  await flush(sender);
  assert.ok(!sender.received.some((m) => m.type === 'signal'));
});

test('garbage, binary and oversized frames do not crash the server', async (t) => {
  const a = await app(t);
  const c = await connect(t, a);
  for (const bad of ['not json', '[]', 'null', '42', '{"type":42}', '{"type":"nope"}', '{"type":"join","key":{}}']) {
    c.send(bad);
    const err = await c.next(bad.includes('join') ? 'not-found' : 'error');
    if (err.type === 'error') assert.equal(err.code, 'bad_message');
  }
  c.send(Buffer.from([0, 1, 2, 255]));
  assert.equal((await c.next('error')).code, 'bad_message');
  c.send({ type: 'host' });
  await c.next('hosted');

  const big = await connect(t, a);
  big.ws.on('error', () => {}); // the server closes it with 1009
  big.send('x'.repeat(64 * 1024 + 1));
  await big.closed;

  await host(t, a); // still serving
});

test('upgrades on any other path are refused', async (t) => {
  const a = await app(t);
  await assert.rejects(connect(t, a, {}, '/other'));
  await assert.rejects(connect(t, a, {}, '/ws/x'));
  await host(t, a);
});

test('join misses are limited per client IP and close the socket', async (t) => {
  const a = await app(t, { configEnv: { TRUST_PROXY: '1', BASE_URL: 'http://files.test' }, rateLimits: { miss: 3 } });
  const ipA = { 'x-forwarded-for': '198.51.100.1' };
  const ipB = { 'x-forwarded-for': '198.51.100.2' };
  const live = await host(t, a);
  const ok = await connect(t, a, ipA);
  ok.send({ type: 'join', key: live.key });
  await ok.next('joined'); // a successful join does not count

  const res = await upload(a);
  const stored = ((await res.json()) as { key: string }).key;
  const c = await connect(t, a, ipA);
  c.send({ type: 'join', key: 'nope' });
  await c.next('not-found');
  for (let i = 0; i < 5; i++) {
    c.send({ type: 'join', key: stored }); // a stored key is a hit, like a successful HTTP lookup
    await c.next('not-live');
  }
  c.send({ type: 'join', key: live.key === '222222' ? '333333' : '222222' });
  await c.next('not-found');
  c.send({ type: 'join', key: 'nope' });
  await c.next('not-found');
  c.send({ type: 'join', key: live.key });
  assert.equal((await c.next('error')).code, 'rate_limited');
  await c.closed;
  const again = await connect(t, a, ipA);
  again.send({ type: 'join', key: 'nope' });
  assert.equal((await again.next('error')).code, 'rate_limited');

  const other = await host(t, a);
  const b = await connect(t, a, ipB);
  b.send({ type: 'join', key: other.key });
  await b.next('joined');
});

test('IPv6 clients share one join-miss and host budget per /56 prefix', async (t) => {
  const a = await app(t, { configEnv: { TRUST_PROXY: '1', BASE_URL: 'http://files.test' }, rateLimits: { miss: 2, ws: 1 } });
  const first = await connect(t, a, { 'x-forwarded-for': '2001:db8:0:1::1' });
  first.send({ type: 'join', key: 'nope' });
  await first.next('not-found');
  first.send({ type: 'join', key: 'nope' });
  await first.next('not-found');
  const rotated = await connect(t, a, { 'x-forwarded-for': '2001:db8:0:ff::2' }); // same /56
  rotated.send({ type: 'join', key: 'nope' });
  assert.equal((await rotated.next('error')).code, 'rate_limited');
  const elsewhere = await connect(t, a, { 'x-forwarded-for': '2001:db8:1::1' }); // another /56
  elsewhere.send({ type: 'join', key: 'nope' });
  await elsewhere.next('not-found');

  const h1 = await connect(t, a, { 'x-forwarded-for': '2001:db8:2:1::1' });
  h1.send({ type: 'host' });
  await h1.next('hosted');
  const h2 = await connect(t, a, { 'x-forwarded-for': '2001:db8:2:2::1' });
  h2.send({ type: 'host' });
  assert.equal((await h2.next('error')).code, 'rate_limited');
});

test('a failed fallback complete releases its claim on the live key', async (t) => {
  let clock = Date.now();
  const a = await app(t, { now: () => clock });
  const { sender, key, liveToken } = await host(t, a);

  const res = await fetch(`${a.base}/api/transfers`, postJson({ files: [{ name: 'a.txt', size: 5 }] }));
  const c = (await res.json()) as { transferId: string; uploadToken: string; files: { fileId: string }[] };
  const fileId = c.files[0]!.fileId;
  const put = await fetch(`${a.base}/api/transfers/${c.transferId}/files/${fileId}/chunks/0`, {
    method: 'PUT',
    headers: { 'x-upload-token': c.uploadToken, 'content-type': 'application/octet-stream' },
    body: 'hello',
  });
  assert.equal(put.status, 204);
  // the part file shrinks behind the server's back: complete fails after claiming the key
  fs.truncateSync(path.join(a.deps.config.dataDir, 'files', c.transferId, `${fileId}.part`), 2);
  const done = await fetch(`${a.base}/api/transfers/${c.transferId}/complete`, {
    method: 'POST',
    headers: { 'x-upload-token': c.uploadToken, 'content-type': 'application/json' },
    body: JSON.stringify({ liveKey: key, liveToken }),
  });
  assert.equal(done.status, 409);

  clock += 10 * 60_000;
  a.signaling.sweep();
  await sender.next('expired');
  assert.equal(a.signaling.isLive(key), false);
});
