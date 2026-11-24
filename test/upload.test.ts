import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import { eq } from 'drizzle-orm';
import { sessions, transfers } from '../src/db/schema.ts';
import { HttpError } from '../src/errors.ts';
import { decryptStream, deriveFileKey } from '../src/lib/crypto.ts';
import { cookieJar, makeTestApp, postJson, type TestApp } from './helpers.ts';

const MB = 2 ** 20;
const KEY_RE = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/;
/** Buffer is a valid fetch body at runtime; lib.dom's BodyInit typing just lacks Buffer<ArrayBufferLike>. */
const raw = (b: Buffer) => b as unknown as BodyInit;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

type Created = {
  transferId: string;
  uploadToken: string;
  chunkBytes: number;
  files: { fileId: string; name: string; size: number }[];
};
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const errCode = async (res: Response) => ((await res.json()) as any).error.code as string;

function api(t: TestApp, f: Fetch = fetch) {
  return {
    create: (body: unknown) => f(`${t.base}/api/transfers`, postJson(body)),
    async created(body: unknown): Promise<Created> {
      const res = await f(`${t.base}/api/transfers`, postJson(body));
      assert.equal(res.status, 201, await res.clone().text());
      return (await res.json()) as Created;
    },
    put: (c: Created, fileIndex: number, index: number | string, data: Buffer, token = c.uploadToken) =>
      fetch(`${t.base}/api/transfers/${c.transferId}/files/${c.files[fileIndex]!.fileId}/chunks/${index}`, {
        method: 'PUT',
        headers: { 'x-upload-token': token, 'content-type': 'application/octet-stream' },
        body: raw(data),
      }),
    complete: (c: Created, token = c.uploadToken) =>
      fetch(`${t.base}/api/transfers/${c.transferId}/complete`, {
        method: 'POST',
        headers: { 'x-upload-token': token },
      }),
  };
}

async function uploadAll(a: ReturnType<typeof api>, c: Created, datas: Buffer[]) {
  for (const [fi, data] of datas.entries()) {
    for (let i = 0; i * c.chunkBytes < data.length; i++) {
      const res = await a.put(c, fi, i, data.subarray(i * c.chunkBytes, (i + 1) * c.chunkBytes));
      assert.equal(res.status, 204, await res.text());
    }
  }
}

async function signedIn(t: TestApp) {
  const jar = cookieJar();
  const email = `u${t.mail.length}@example.com`;
  await fetch(`${t.base}/api/auth/signup`, postJson({ name: 'U', email, password: 'password1' }));
  const token = t.mail.at(-1)!.text.match(/\/confirm\/([A-Za-z0-9_-]{43})/)![1];
  assert.equal((await jar.fetch(`${t.base}/confirm/${token}`)).status, 302);
  return jar;
}

const dirOf = (t: TestApp, transferId: string) => path.join(t.deps.config.dataDir, 'files', transferId);

describe('chunked uploads', () => {
  let t: TestApp;
  let a: ReturnType<typeof api>;
  before(async () => {
    t = await makeTestApp({ configEnv: { CHUNK_MB: '1' } });
    a = api(t);
  });
  after(() => t.close());

  it('uploads a 2.5 MB file in 3 chunks plus a 10-byte file, re-sent chunk included', async () => {
    const big = randomBytes(2.5 * MB);
    const small = randomBytes(10);
    const c = await a.created({ files: [{ name: 'big.bin', size: big.length }, { name: '../small.txt', size: 10, mime: 'text/plain' }] });
    assert.equal(c.chunkBytes, MB);
    assert.deepEqual(c.files.map((f) => [f.name, f.size]), [['big.bin', big.length], ['small.txt', 10]]);
    assert.match(c.uploadToken, /^[A-Za-z0-9_-]{43}$/);

    await uploadAll(a, c, [big, small]);
    assert.equal((await a.put(c, 0, 1, big.subarray(MB, 2 * MB))).status, 204); // re-send overwrites

    const res = await a.complete(c);
    assert.equal(res.status, 200);
    const ready = (await res.json()) as any;
    assert.match(ready.key, KEY_RE);
    assert.equal(ready.url, `${t.base}/${ready.key}`);
    assert.equal(ready.protected, false);
    assert.deepEqual(ready.files.map((f: any) => [f.fileId, f.name, f.size]), c.files.map((f) => [f.fileId, f.name, f.size]));

    const dir = dirOf(t, c.transferId);
    assert.deepEqual(fs.readdirSync(dir).sort(), c.files.map((f) => f.fileId).sort()); // no .part left
    assert.equal(sha(fs.readFileSync(path.join(dir, c.files[0]!.fileId))), sha(big));
    assert.equal(sha(fs.readFileSync(path.join(dir, c.files[1]!.fileId))), sha(small));

    const rec = await t.deps.transfers.findReady(ready.key.toLowerCase());
    assert.ok(rec);
    assert.equal(rec.transfer.id, c.transferId);
    assert.deepEqual(rec.files.map((f) => [f.originalName, f.mime, f.position]), [
      ['big.bin', 'application/octet-stream', 0],
      ['small.txt', 'text/plain', 1],
    ]);

    const again = await a.complete(c);
    assert.equal(again.status, 409);
    assert.equal(await errCode(again), 'not_uploading');
    const late = await a.put(c, 1, 0, small);
    assert.equal(late.status, 409);
    assert.equal(await errCode(late), 'not_uploading');
  });

  it('a zero-byte file completes with no chunks; any chunk is bad_chunk', async () => {
    const c = await a.created({ files: [{ name: 'empty', size: 0 }] });
    const put = await a.put(c, 0, 0, Buffer.alloc(0));
    assert.equal(put.status, 400);
    assert.equal(await errCode(put), 'bad_chunk');
    const res = await a.complete(c);
    assert.equal(res.status, 200);
    const ready = (await res.json()) as any;
    assert.equal(ready.files[0].size, 0);
    assert.equal(fs.statSync(path.join(dirOf(t, c.transferId), c.files[0]!.fileId)).size, 0);
  });

  it('rejects oversized, out-of-range, short, malformed and unauthorised chunks', async () => {
    const big = randomBytes(2.5 * MB);
    const c = await a.created({ files: [{ name: 'b', size: big.length }] });

    const tooBig = await a.put(c, 0, 2, big.subarray(0, MB));
    assert.equal(tooBig.status, 413);
    assert.equal(await errCode(tooBig), 'chunk_too_large');

    const short = await a.put(c, 0, 0, big.subarray(0, MB / 2));
    assert.equal(short.status, 400);
    assert.equal(await errCode(short), 'short_chunk');

    for (const index of [3, -1, 'abc', '1.5', '01e3']) {
      const res = await a.put(c, 0, index, big.subarray(0, 10));
      assert.equal(res.status, 400, `index ${index}`);
      assert.equal(await errCode(res), 'bad_chunk');
    }

    const wrong = await a.put(c, 0, 0, big.subarray(0, MB), 'not-the-token');
    assert.equal(wrong.status, 403);
    assert.equal(await errCode(wrong), 'bad_token');
    const noToken = await fetch(`${t.base}/api/transfers/${c.transferId}/complete`, { method: 'POST' });
    assert.equal(noToken.status, 403);

    const hostile = [
      `${t.base}/api/transfers/..%2F..%2Fetc/files/${c.files[0]!.fileId}/chunks/0`,
      `${t.base}/api/transfers/${c.transferId}/files/..%2Fapp.db/chunks/0`,
      `${t.base}/api/transfers/00000000-0000-4000-8000-000000000000/files/${c.files[0]!.fileId}/chunks/0`,
      `${t.base}/api/transfers/${c.transferId}/files/00000000-0000-4000-8000-000000000000/chunks/0`,
    ];
    for (const url of hostile) {
      const res = await fetch(url, { method: 'PUT', headers: { 'x-upload-token': c.uploadToken }, body: raw(big.subarray(0, 10)) });
      assert.equal(res.status, 404, url);
      assert.equal(await errCode(res), 'not_found');
    }
    const missing = await fetch(`${t.base}/api/transfers/nope/complete`, { method: 'POST', headers: { 'x-upload-token': 'x' } });
    assert.equal(missing.status, 404);
  });

  it('a streamed chunk that overflows is aborted with 413 and nothing lands past its range', async () => {
    const big = randomBytes(2.5 * MB);
    const c = await a.created({ files: [{ name: 'b', size: big.length }] });
    await uploadAll(a, c, [big.subarray(0, 2 * MB)]); // chunks 0 and 1
    const part = path.join(dirOf(t, c.transferId), `${c.files[0]!.fileId}.part`);
    // chunk 2 takes 0.5 MB: the first 400 kB fit and are on disk before the overflowing 400 kB arrive
    const body = Readable.from(
      (async function* () {
        yield randomBytes(400_000);
        while (fs.statSync(part).size < 2 * MB + 400_000) await new Promise((r) => setTimeout(r, 5));
        yield randomBytes(400_000);
      })(),
    );
    await assert.rejects(
      t.deps.transfers.writeChunk(c.transferId, c.files[0]!.fileId, 2, c.uploadToken, body),
      (err) => err instanceof HttpError && err.status === 413 && err.code === 'chunk_too_large',
    );
    assert.ok(body.destroyed);
    assert.equal(fs.statSync(part).size, 2 * MB + 400_000); // the overflowing piece is not written at all
    const res = await a.complete(c);
    assert.equal(res.status, 409);
    assert.equal(await errCode(res), 'incomplete');
  });

  it('complete with a missing middle or last chunk is 409 incomplete', async () => {
    const big = randomBytes(2.5 * MB);
    const c = await a.created({ files: [{ name: 'b', size: big.length }] });
    assert.equal((await a.put(c, 0, 0, big.subarray(0, MB))).status, 204);
    assert.equal((await a.put(c, 0, 2, big.subarray(2 * MB))).status, 204); // .part is full size now, with a hole
    const hole = await a.complete(c);
    assert.equal(hole.status, 409);
    assert.equal(await errCode(hole), 'incomplete');

    const c2 = await a.created({ files: [{ name: 'b', size: big.length }] });
    await uploadAll(a, c2, [big.subarray(0, 2 * MB)]);
    const tail = await a.complete(c2);
    assert.equal(tail.status, 409);
    assert.equal(await errCode(tail), 'incomplete');
    await assert.doesNotReject(async () => {
      assert.equal((await a.put(c2, 0, 2, big.subarray(2 * MB))).status, 204);
      assert.equal((await a.complete(c2)).status, 200);
    });
  });

  it('remove refuses an id that is not a UUID and deletes nothing', async () => {
    const c = await a.created({ files: [{ name: 'b', size: 1 }] });
    for (const id of ['..', '../..', `${c.transferId}/..`]) {
      await assert.rejects(t.deps.transfers.remove(id), (err) => err instanceof HttpError && err.code === 'not_found');
    }
    assert.ok(fs.existsSync(path.join(t.deps.config.dataDir, 'app.db')));
    assert.ok(fs.existsSync(dirOf(t, c.transferId)));
  });

  it('a client that disconnects mid-chunk does not break the server', async () => {
    const c = await a.created({ files: [{ name: 'b', size: MB }] });
    const url = new URL(`${t.base}/api/transfers/${c.transferId}/files/${c.files[0]!.fileId}/chunks/0`);
    const logged: unknown[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => void logged.push(args);
    try {
      await new Promise<void>((resolve) => {
        const req = http.request(url, {
          method: 'PUT',
          headers: { 'x-upload-token': c.uploadToken, 'content-length': String(MB) },
        });
        req.on('error', () => resolve());
        req.write(randomBytes(100_000), () => setTimeout(() => (req.destroy(), resolve()), 50));
      });
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      console.error = origError;
    }
    assert.deepEqual(logged, [], 'a disconnect is not a server error');
    const res = await a.complete(c);
    assert.equal(res.status, 409);
    assert.equal(await errCode(res), 'incomplete');
    assert.equal((await a.put(c, 0, 0, randomBytes(MB))).status, 204);
    assert.equal((await a.complete(c)).status, 200);
  });
});

describe('transfer limits and passwords', () => {
  let t: TestApp;
  let a: ReturnType<typeof api>;
  before(async () => {
    t = await makeTestApp({ configEnv: { CHUNK_MB: '1', MAX_FILES_PER_TRANSFER: '2', MAX_FILE_MB: '1', MAX_TRANSFER_MB: '1.5' } });
    a = api(t);
  });
  after(() => t.close());

  it('enforces file count, file size and transfer size', async () => {
    const cases: [unknown, string][] = [
      [{ files: [{ name: 'a', size: 1 }, { name: 'b', size: 1 }, { name: 'c', size: 1 }] }, 'too_many_files'],
      [{ files: [{ name: 'a', size: MB + 1 }] }, 'file_too_large'],
      [{ files: [{ name: 'a', size: MB }, { name: 'b', size: MB }] }, 'transfer_too_large'],
      [{ files: [] }, 'invalid_request'],
      [{ files: [{ name: 'a', size: -1 }] }, 'invalid_request'],
      [{ files: [{ name: 'a', size: 1.5 }] }, 'invalid_request'],
      [{ files: [{ name: 'a', size: 1 }], password: '' }, 'invalid_request'],
    ];
    for (const [body, code] of cases) {
      const res = await a.create(body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(await errCode(res), code);
    }
  });

  it('a password needs a signed-in user', async () => {
    const res = await a.create({ files: [{ name: 'a', size: 1 }], password: 'secret' });
    assert.equal(res.status, 401);
    assert.equal(await errCode(res), 'auth_required');
  });

  it('a protected transfer is stored encrypted and the password is not stored', async () => {
    const jar = await signedIn(t);
    const data = randomBytes(0.9 * MB);
    const c = await api(t, jar.fetch).created({ files: [{ name: 'a', size: data.length }], password: 'secret' });
    await uploadAll(a, c, [data]);
    const res = await a.complete(c);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as any).protected, true);

    const row = t.deps.db.select().from(transfers).where(eq(transfers.id, c.transferId)).get()!;
    assert.match(row.passwordHash!, /^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
    assert.equal(row.ownerId, 1);
    assert.ok(!JSON.stringify(row).includes('secret'));
    const stored = path.join(dirOf(t, c.transferId), c.files[0]!.fileId);
    assert.equal(fs.statSync(stored).size, data.length + 28);
    assert.notEqual(sha(fs.readFileSync(stored)), sha(data));
    const plain = await decryptStream(stored, await deriveFileKey('secret', row.encSalt!));
    const chunks: Buffer[] = [];
    for await (const ch of plain) chunks.push(ch as Buffer);
    assert.equal(sha(Buffer.concat(chunks)), sha(data));
  });
});

describe('storage cap', () => {
  it('rejects a create that would pass the cap before any chunk is sent', async () => {
    const t = await makeTestApp({ configEnv: { CHUNK_MB: '1', STORAGE_CAP_GB: '0.003' } });
    try {
      const a = api(t);
      const first = await a.created({ files: [{ name: 'a', size: 2 * MB }] });
      const res = await a.create({ files: [{ name: 'b', size: 2 * MB }] });
      assert.equal(res.status, 507);
      assert.equal(await errCode(res), 'storage_full');
      await t.deps.transfers.remove(first.transferId);
      assert.equal(fs.existsSync(dirOf(t, first.transferId)), false);
      assert.equal((await a.create({ files: [{ name: 'b', size: 2 * MB }] })).status, 201);
    } finally {
      await t.close();
    }
  });

  it('two concurrent creates cannot both pass the cap', async () => {
    const t = await makeTestApp({ configEnv: { CHUNK_MB: '1', STORAGE_CAP_GB: '0.003' } });
    try {
      const jar = await signedIn(t);
      const a = api(t, jar.fetch);
      const body = { files: [{ name: 'a', size: 2 * MB }], password: 'secret' };
      const results = await Promise.all([a.create(body), a.create(body)]);
      assert.deepEqual(results.map((r) => r.status).sort(), [201, 507]);
      assert.equal(t.deps.db.select().from(transfers).all().length, 1);
    } finally {
      await t.close();
    }
  });
});

describe('upload reservations per client IP', () => {
  let t: TestApp;
  before(async () => {
    t = await makeTestApp({
      configEnv: { CHUNK_MB: '1', MAX_TRANSFER_MB: '2', TRUST_PROXY: '1', BASE_URL: 'http://files.test' },
    });
  });
  after(() => t.close());
  /** fetch as a client behind the trusted proxy with this IP. */
  const from =
    (ip: string): Fetch =>
    (url, init = {}) =>
      fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), 'x-forwarded-for': ip } });

  it('caps the bytes one IP has reserved in unfinished uploads at the transfer limit', async () => {
    const one = api(t, from('198.51.100.1'));
    const first = await one.created({ files: [{ name: 'a', size: 2 * MB }] });
    const res = await one.create({ files: [{ name: 'b', size: 1 }] });
    assert.equal(res.status, 429);
    assert.equal(await errCode(res), 'too_many_uploads');
    // another client is not affected
    await api(t, from('198.51.100.2')).created({ files: [{ name: 'c', size: 2 * MB }] });
    // finishing (here: removing) the first upload frees the reservation
    await t.deps.transfers.remove(first.transferId);
    await one.created({ files: [{ name: 'b', size: 1 }] });
  });

  it('counts IPv6 clients by prefix, so rotating addresses inside it does not help', async () => {
    await api(t, from('2001:db8:0:1::1')).created({ files: [{ name: 'a', size: 2 * MB }] });
    const res = await api(t, from('2001:db8:0:2::9')).create({ files: [{ name: 'b', size: 1 }] });
    assert.equal(res.status, 429);
    assert.equal(await errCode(res), 'too_many_uploads');
    await api(t, from('2001:db8:1:1::1')).created({ files: [{ name: 'c', size: 1 }] }); // another /56
  });
});

describe('expiry and cleanup', () => {
  const HOUR = 3600_000;
  let now = Date.parse('2026-01-01T00:00:00Z');
  let t: TestApp;
  let a: ReturnType<typeof api>;
  before(async () => {
    t = await makeTestApp({ now: () => now, configEnv: { CHUNK_MB: '1' } });
    a = api(t);
  });
  after(() => t.close());

  it('removes ready transfers after 24 h and abandoned uploads after 60 min', async () => {
    const data = randomBytes(100);
    const created = now;
    const ready = await a.created({ files: [{ name: 'a', size: data.length }] });
    await uploadAll(a, ready, [data]);
    now += 30 * 60_000; // TTL counts from complete
    const done = (await (await a.complete(ready)).json()) as any;
    assert.equal(done.expiresAt, now + 24 * HOUR);
    const abandoned = await a.created({ files: [{ name: 'b', size: 10 }] });

    now += 61 * 60_000;
    const fresh = await a.created({ files: [{ name: 'c', size: 10 }] });
    t.deps.db.insert(sessions).values({ sid: 'old', data: '{}', expiresAt: new Date(now - 1) }).run();
    t.deps.db.insert(sessions).values({ sid: 'live', data: '{}', expiresAt: new Date(now + HOUR) }).run();

    assert.equal(await t.deps.transfers.cleanup(), 1);
    assert.equal(fs.existsSync(dirOf(t, abandoned.transferId)), false);
    assert.ok(fs.existsSync(dirOf(t, fresh.transferId)));
    assert.ok(fs.existsSync(dirOf(t, ready.transferId)));
    assert.deepEqual(t.deps.db.select({ sid: sessions.sid }).from(sessions).all(), [{ sid: 'live' }]);
    assert.ok(await t.deps.transfers.findReady(done.key));

    now = created + 30 * 60_000 + 24 * HOUR; // exactly at expiresAt
    assert.equal(await t.deps.transfers.findReady(done.key), null);
    assert.equal(await t.deps.transfers.cleanup(), 2); // the ready one and the now-abandoned fresh one
    assert.equal(fs.existsSync(dirOf(t, ready.transferId)), false);
    assert.equal(t.deps.db.select().from(transfers).all().length, 0);
  });

  it('failing chunk PUTs do not keep an upload alive', async () => {
    const c = await a.created({ files: [{ name: 'b', size: MB + 1 }] });
    assert.equal((await a.put(c, 0, 0, randomBytes(MB))).status, 204);
    for (let i = 0; i < 3; i++) {
      now += 25 * 60_000;
      const res = await a.put(c, 0, 0, randomBytes(1)); // short_chunk
      assert.equal(res.status, 400);
      assert.equal(await errCode(res), 'short_chunk');
    }
    // 75 min since the last chunk that was written, 0 min since the last failed one
    assert.equal(await t.deps.transfers.cleanup(), 1);
    assert.equal(fs.existsSync(dirOf(t, c.transferId)), false);
  });

  it('keeps an upload that is still sending chunks, but never past the transfer TTL', async () => {
    const created = now;
    const c = await a.created({ files: [{ name: 'b', size: MB + 1 }] });
    assert.equal((await a.put(c, 0, 0, randomBytes(MB))).status, 204);
    const tick = async () => assert.equal((await a.put(c, 0, 1, randomBytes(1))).status, 204);

    now += 59 * 60_000;
    await tick();
    now += 2 * 60_000; // 61 min since create, 2 min since the last chunk
    assert.equal(await t.deps.transfers.cleanup(), 0);
    assert.ok(fs.existsSync(dirOf(t, c.transferId)));

    now = created + 24 * HOUR - 60_000;
    await tick(); // still active, but the reservation cannot be held forever
    now = created + 24 * HOUR;
    assert.equal(await t.deps.transfers.cleanup(), 1);
    assert.equal(fs.existsSync(dirOf(t, c.transferId)), false);
    assert.equal(t.deps.db.select().from(transfers).all().length, 0);
  });
});
