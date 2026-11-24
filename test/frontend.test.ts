import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLimits, isRetryable, planChunks, uploadTransfer, xhrPutChunk } from '../public/js/upload.js';
import { decodeHeader, encodeHeader, joinOutcome, receiveFiles, sendFiles } from '../public/js/direct.js';

const publicDir = fileURLToPath(new URL('../public', import.meta.url));

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('planChunks splits a size into chunk ranges', () => {
  assert.deepEqual(planChunks(0, 10), []);
  assert.deepEqual(planChunks(25, 10), [
    { index: 0, start: 0, end: 10 },
    { index: 1, start: 10, end: 20 },
    { index: 2, start: 20, end: 25 },
  ]);
  assert.deepEqual(planChunks(20, 10).map((c) => c.end), [10, 20]);
});

test('checkLimits reports files over the configured limits', () => {
  const limits = { maxFileBytes: 10, maxFilesPerTransfer: 2, maxTransferBytes: 15 };
  const f = (size: number) => ({ name: 'a', size });
  assert.equal(checkLimits([f(5), f(5)], limits), null);
  assert.match(checkLimits([], limits) ?? '', /at least one/i);
  assert.match(checkLimits([f(1), f(1), f(1)], limits) ?? '', /up to 2 files/);
  assert.match(checkLimits([f(11)], limits) ?? '', /larger than/);
  assert.match(checkLimits([f(8), f(8)], limits) ?? '', /together/);
});

test('header encode/decode round-trips a non-ASCII name', () => {
  const meta = { name: 'тест.txt', size: 12, mime: 'text/plain' };
  const encoded = encodeHeader(meta);
  assert.equal(typeof encoded, 'string');
  assert.deepEqual(decodeHeader(encoded), meta);
  assert.deepEqual(decodeHeader(new TextEncoder().encode(encoded)), meta);
});

test('uploadTransfer retries a failed chunk with backoff, then completes', async () => {
  const calls: string[] = [];
  let chunkFailures = 0;
  const fakeFetch = async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    calls.push(`${method} ${url}`);
    if (method === 'POST' && url === '/api/transfers') {
      assert.deepEqual(JSON.parse(String(init.body)), { files: [{ name: 'a.txt', size: 15, mime: 'text/plain' }] });
      return json(201, { transferId: 't1', uploadToken: 'tok', chunkBytes: 10, files: [{ fileId: 'f1', name: 'a.txt', size: 15 }] });
    }
    if (method === 'PUT') {
      assert.equal(new Headers(init.headers).get('x-upload-token'), 'tok');
      if (url.endsWith('/chunks/1') && chunkFailures < 2) {
        chunkFailures++;
        return json(500, { error: { code: 'internal', message: 'Internal server error' } });
      }
      return new Response(null, { status: 204 });
    }
    if (method === 'POST' && url === '/api/transfers/t1/complete') {
      assert.deepEqual(JSON.parse(String(init.body)), { liveKey: 'K7PX3M', liveToken: 'lt' });
      return json(200, { key: 'ABCDEF', url: 'http://x/ABCDEF', expiresAt: 1, protected: false, files: [] });
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  const sleeps: number[] = [];
  const progress: [number, number][] = [];
  const file = new File(['0123456789abcde'], 'a.txt', { type: 'text/plain' });
  const ready = await uploadTransfer([file], {
    liveKey: 'K7PX3M',
    liveToken: 'lt',
    fetch: fakeFetch,
    sleep: async (ms: number) => void sleeps.push(ms),
    onProgress: (sent: number, total: number) => progress.push([sent, total]),
  });
  assert.equal(ready.key, 'ABCDEF');
  assert.deepEqual(sleeps, [1000, 2000]);
  assert.deepEqual(calls, [
    'POST /api/transfers',
    'PUT /api/transfers/t1/files/f1/chunks/0',
    'PUT /api/transfers/t1/files/f1/chunks/1',
    'PUT /api/transfers/t1/files/f1/chunks/1',
    'PUT /api/transfers/t1/files/f1/chunks/1',
    'POST /api/transfers/t1/complete',
  ]);
  assert.deepEqual(progress.at(-1), [15, 15]);
});

test('uploadTransfer gives up after 3 retries and does not retry plain 4xx', async () => {
  const run = async (status: number, code: string) => {
    let puts = 0;
    const fakeFetch = async (url: string, init: RequestInit = {}) => {
      if (init.method === 'PUT') {
        puts++;
        return json(status, { error: { code, message: 'nope' } });
      }
      if (url === '/api/transfers') {
        return json(201, { transferId: 't', uploadToken: 'x', chunkBytes: 10, files: [{ fileId: 'f', name: 'a', size: 1 }] });
      }
      throw new Error('unexpected');
    };
    const sleeps: number[] = [];
    const err = await uploadTransfer([new File(['a'], 'a')], {
      fetch: fakeFetch,
      sleep: async (ms: number) => void sleeps.push(ms),
    }).catch((e: unknown) => e);
    return { puts, sleeps, err: err as { status: number; code: string } };
  };
  const server = await run(503, 'unavailable');
  assert.equal(server.puts, 4);
  assert.deepEqual(server.sleeps, [1000, 2000, 4000]);
  assert.equal(server.err.status, 503);

  const client = await run(403, 'bad_token');
  assert.equal(client.puts, 1);
  assert.equal(client.err.code, 'bad_token');

  const limited = await run(429, 'rate_limited');
  assert.equal(limited.puts, 4);
});

test('a join answer other than joined or busy falls back to the stored lookup', () => {
  assert.equal(joinOutcome({ type: 'joined' }), 'direct');
  assert.equal(joinOutcome({ type: 'busy' }), 'busy');
  // a rate-limited join must not block opening a stored transfer: HTTP decides
  assert.equal(joinOutcome({ type: 'error', code: 'rate_limited' }), 'stored');
  for (const type of ['not-live', 'not-found', 'closed']) assert.equal(joinOutcome({ type }), 'stored');
});

/** Runs xhrPutChunk against a fake XHR driven by `script(xhr)` after send. */
async function runXhr(script: (xhr: any) => void, stallMs: number) {
  class FakeXhr {
    timeout = 0;
    status = 200;
    responseText = '';
    upload: { onprogress: ((e: { loaded: number }) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null;
    open() {}
    setRequestHeader() {}
    send() {
      queueMicrotask(() => script(this));
    }
  }
  const g = globalThis as { XMLHttpRequest?: unknown };
  const saved = g.XMLHttpRequest;
  g.XMLHttpRequest = FakeXhr;
  try {
    return await xhrPutChunk('/x', new Blob(['a']), 'tok', () => {}, stallMs).then(
      () => null,
      (e: unknown) => e,
    );
  } finally {
    g.XMLHttpRequest = saved;
  }
}

test('xhrPutChunk fails with a retryable timeout when no progress arrives', async () => {
  const err = await runXhr(() => {}, 30);
  assert.equal((err as { code: string }).code, 'timeout');
  assert.equal(isRetryable(err), true);
});

test('xhrPutChunk has no hard deadline: steady progress keeps a slow request alive', async () => {
  const err = await runXhr((xhr) => {
    let n = 0;
    const tick = setInterval(() => {
      xhr.upload.onprogress({ loaded: ++n });
      if (n === 12) {
        clearInterval(tick);
        xhr.onload();
      }
    }, 10); // 120 ms in total, four times the 30 ms stall limit
  }, 30);
  assert.equal(err, null);
});

/** Two fake data channels wired to each other, delivering messages asynchronously in order. */
function channelPair() {
  type Fake = {
    binaryType: string;
    bufferedAmount: number;
    bufferedAmountLowThreshold: number;
    onmessage: ((e: { data: unknown }) => void) | null;
    onclose: (() => void) | null;
    send(data: unknown): void;
    addEventListener(type: string, fn: () => void, opts?: unknown): void;
    removeEventListener(type: string, fn: () => void): void;
  };
  const make = (): Fake => ({
    binaryType: 'blob',
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    onmessage: null,
    onclose: null,
    send() {},
    addEventListener() {},
    removeEventListener() {},
  });
  const a = make();
  const b = make();
  const wire = (from: Fake, to: Fake) => {
    from.send = (data) => {
      const copy = typeof data === 'string' ? data : new Uint8Array(data as ArrayBuffer).slice().buffer;
      queueMicrotask(() => to.onmessage?.({ data: copy }));
    };
  };
  wire(a, b);
  wire(b, a);
  return [a, b] as const;
}

test('sendFiles and receiveFiles move files over a data channel', async () => {
  const [tx, rx] = channelPair();
  const big = new Uint8Array(200 * 1024).map((_, i) => i % 251);
  const files = [new File([big], 'big.bin', { type: 'application/octet-stream' }), new File([], 'empty.txt')];
  const got: { name: string; size: number; blob: Blob }[] = [];
  const done = receiveFiles(rx, (f: { name: string; size: number; blob: Blob }) => got.push(f));
  await sendFiles(tx, files);
  await done;
  assert.equal(tx.bufferedAmountLowThreshold, 1024 * 1024);
  assert.deepEqual(got.map((f) => [f.name, f.size]), [['big.bin', big.length], ['empty.txt', 0]]);
  assert.deepEqual(new Uint8Array(await got[0]!.blob.arrayBuffer()), big);
});

test('public/index.html loads nothing from other origins', () => {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/\b(?:src|href)\s*=\s*["']?([^"'\s>]+)/gi)].map((m) => m[1]!);
  assert.ok(refs.length > 0);
  for (const ref of refs) assert.doesNotMatch(ref, /^(?:https?:)?\/\//i, ref);
  assert.doesNotMatch(html, /https?:\/\//i);
});

test('no file under public/ mentions send-anywhere', () => {
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? walk(p) : [p];
    });
  for (const file of walk(publicDir)) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /send-anywhere/i, file);
  }
});
