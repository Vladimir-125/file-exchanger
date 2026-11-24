import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { cookieJar, makeTestApp, postJson, type TestApp } from './helpers.ts';

const MB = 2 ** 20;
const raw = (b: Buffer) => b as unknown as BodyInit;
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
type Ready = { key: string; url: string; expiresAt: number; protected: boolean; files: { fileId: string; name: string; size: number }[] };
type Upload = { name: string; data: Buffer; mime?: string };

const errCode = async (res: Response) => ((await res.json()) as any).error.code as string;
const body = async (res: Response) => Buffer.from(await res.arrayBuffer());

/** Uploads files through the public API and completes the transfer. */
async function share(t: TestApp, files: Upload[], opts: { password?: string; f?: Fetch } = {}) {
  const f = opts.f ?? fetch;
  const res = await f(
    `${t.base}/api/transfers`,
    postJson({ files: files.map((u) => ({ name: u.name, size: u.data.length, mime: u.mime })), password: opts.password }),
  );
  assert.equal(res.status, 201, await res.clone().text());
  const c = (await res.json()) as { transferId: string; uploadToken: string; chunkBytes: number; files: { fileId: string }[] };
  for (const [fi, u] of files.entries()) {
    for (let i = 0; i * c.chunkBytes < u.data.length; i++) {
      const put = await fetch(`${t.base}/api/transfers/${c.transferId}/files/${c.files[fi]!.fileId}/chunks/${i}`, {
        method: 'PUT',
        headers: { 'x-upload-token': c.uploadToken },
        body: raw(u.data.subarray(i * c.chunkBytes, (i + 1) * c.chunkBytes)),
      });
      assert.equal(put.status, 204, await put.text());
    }
  }
  const done = await fetch(`${t.base}/api/transfers/${c.transferId}/complete`, {
    method: 'POST',
    headers: { 'x-upload-token': c.uploadToken },
  });
  assert.equal(done.status, 200, await done.clone().text());
  return { transferId: c.transferId, ready: (await done.json()) as Ready };
}

async function signedIn(t: TestApp) {
  const jar = cookieJar();
  const email = `u${t.mail.length}@example.com`;
  await fetch(`${t.base}/api/auth/signup`, postJson({ name: 'U', email, password: 'password1' }));
  const token = t.mail.at(-1)!.text.match(/\/confirm\/([A-Za-z0-9_-]{43})/)![1];
  assert.equal((await jar.fetch(`${t.base}/confirm/${token}`)).status, 302);
  return jar;
}

describe('plain transfers', () => {
  let t: TestApp;
  before(async () => {
    t = await makeTestApp({ configEnv: { CHUNK_MB: '1' } });
  });
  after(() => t.close());

  it('metadata lists files; a download returns identical bytes; a lowercase key works', async () => {
    const big = randomBytes(2.5 * MB);
    const small = Buffer.from('hello world');
    const { ready } = await share(t, [
      { name: 'big.bin', data: big },
      { name: 'note.txt', data: small, mime: 'text/plain' },
    ]);

    const meta = await fetch(`${t.base}/api/transfers/${ready.key.toLowerCase()}`);
    assert.equal(meta.status, 200);
    const m = (await meta.json()) as any;
    assert.deepEqual(Object.keys(m).sort(), ['expiresAt', 'files', 'key', 'protected']);
    assert.equal(m.key, ready.key);
    assert.equal(m.protected, false);
    assert.equal(m.expiresAt, ready.expiresAt);
    assert.deepEqual(m.files, ready.files);

    const res = await fetch(`${t.base}/api/transfers/${ready.key.toLowerCase()}/files/${ready.files[0]!.fileId}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-length'), String(big.length));
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-disposition')!, /^attachment; filename="?big\.bin"?$/);
    assert.ok((await body(res)).equals(big));

    const txt = await fetch(`${t.base}/api/transfers/${ready.key}/files/${ready.files[1]!.fileId}`);
    assert.match(txt.headers.get('content-type')!, /^text\/plain/);
    assert.match(txt.headers.get('content-disposition')!, /^attachment;/);
    assert.ok((await body(txt)).equals(small));
  });

  it('a zip holds every file as a stored entry under its display name, duplicates suffixed', async () => {
    const a = Buffer.from('first file body');
    const b = Buffer.from('second file body');
    const c = Buffer.from('third file body');
    const { ready } = await share(t, [
      { name: 'a.txt', data: a },
      { name: 'other.bin', data: b },
      { name: 'a.txt', data: c },
    ]);
    const res = await fetch(`${t.base}/api/transfers/${ready.key}/zip`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/zip');
    assert.equal(res.headers.get('content-disposition'), `attachment; filename="${ready.key}.zip"`);
    const zip = await body(res);
    assert.ok(zip.subarray(0, 4).equals(Buffer.from('PK\x03\x04', 'latin1')));
    for (const name of ['a.txt', 'other.bin', 'a (2).txt']) assert.ok(zip.includes(name), name);
    for (const data of [a, b, c]) assert.ok(zip.includes(data)); // stored, not compressed
  });

  it('HEAD on a file or zip answers the headers without opening any stream', async () => {
    const data = randomBytes(1000);
    const { ready } = await share(t, [{ name: 'h.bin', data }]);
    const svc = t.deps.transfers;
    const opened: string[] = [];
    const { openFile, openZip } = svc;
    svc.openFile = (...args) => (opened.push('file'), openFile(...args));
    svc.openZip = (...args) => (opened.push('zip'), openZip(...args));
    try {
      const file = await fetch(`${t.base}/api/transfers/${ready.key}/files/${ready.files[0]!.fileId}`, { method: 'HEAD' });
      assert.equal(file.status, 200);
      assert.equal(file.headers.get('content-length'), String(data.length));
      assert.match(file.headers.get('content-disposition')!, /^attachment; filename="?h\.bin"?$/);
      assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
      const zip = await fetch(`${t.base}/api/transfers/${ready.key}/zip`, { method: 'HEAD' });
      assert.equal(zip.status, 200);
      assert.equal(zip.headers.get('content-disposition'), `attachment; filename="${ready.key}.zip"`);
      const missing = await fetch(`${t.base}/api/transfers/${ready.key}/files/00000000-0000-4000-8000-000000000000`, { method: 'HEAD' });
      assert.equal(missing.status, 404);
      assert.deepEqual(opened, []);
    } finally {
      svc.openFile = openFile;
      svc.openZip = openZip;
    }
  });

  it('a zero-byte file downloads as an empty 200', async () => {
    const { ready } = await share(t, [{ name: 'empty.txt', data: Buffer.alloc(0) }]);
    const res = await fetch(`${t.base}/api/transfers/${ready.key}/files/${ready.files[0]!.fileId}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-length'), '0');
    assert.equal((await body(res)).length, 0);
  });

  it('unknown, malformed and expired keys and unknown files are 404 not_found', async () => {
    const { ready } = await share(t, [{ name: 'x', data: Buffer.from('x') }]);
    for (const key of ['ZZZZZZ', 'abc', 'A'.repeat(40), '..%2F..']) {
      const res = await fetch(`${t.base}/api/transfers/${key}`);
      assert.equal(res.status, 404, key);
      assert.equal(await errCode(res), 'not_found');
    }
    for (const fileId of ['nope', '00000000-0000-4000-8000-000000000000']) {
      const res = await fetch(`${t.base}/api/transfers/${ready.key}/files/${fileId}`);
      assert.equal(res.status, 404);
      assert.equal(await errCode(res), 'not_found');
    }
    const zip = await fetch(`${t.base}/api/transfers/ZZZZZZ/zip`);
    assert.equal(zip.status, 404);
  });

  it('unlocking an unprotected transfer is 400 not_protected', async () => {
    const { ready } = await share(t, [{ name: 'x', data: Buffer.from('x') }]);
    const res = await fetch(`${t.base}/api/transfers/${ready.key}/unlock`, postJson({ password: 'pw123456' }));
    assert.equal(res.status, 400);
    assert.equal(await errCode(res), 'not_protected');
  });
});

describe('expiry', () => {
  it('an expired transfer is 404 for metadata and downloads', async () => {
    let skew = 0;
    const t = await makeTestApp({ now: () => Date.now() + skew });
    try {
      const { ready } = await share(t, [{ name: 'x', data: Buffer.from('x') }]);
      skew = 24 * 3600_000 + 1000;
      for (const url of [`/api/transfers/${ready.key}`, `/api/transfers/${ready.key}/files/${ready.files[0]!.fileId}`]) {
        const res = await fetch(`${t.base}${url}`);
        assert.equal(res.status, 404, url);
        assert.equal(await errCode(res), 'not_found');
      }
    } finally {
      await t.close();
    }
  });
});

describe('protected transfers', () => {
  let t: TestApp;
  let skew = 0;
  let sender: Awaited<ReturnType<typeof signedIn>>;
  const secret = randomBytes(300_000);
  const second = Buffer.from('second secret');
  let ready: Ready;
  let other: Ready;
  before(async () => {
    t = await makeTestApp({ now: () => Date.now() + skew, configEnv: { CHUNK_MB: '1' } });
    sender = await signedIn(t);
    const f = sender.fetch.bind(sender);
    ({ ready } = await share(t, [{ name: 'secret.bin', data: secret }, { name: 's.txt', data: second }], { password: 'pw123456', f }));
    ({ ready: other } = await share(t, [{ name: 'other', data: Buffer.from('o') }], { password: 'other-pass', f }));
  });
  after(() => t.close());

  const unlock = (key: string, password: string) =>
    fetch(`${t.base}/api/transfers/${key}/unlock`, postJson({ password })); // receiver: no cookie
  const grantFor = async (key: string, password: string) => ((await (await unlock(key, password)).json()) as any).grant as string;
  const fileUrl = (r: Ready, i: number, grant?: string) =>
    `${t.base}/api/transfers/${r.key}/files/${r.files[i]!.fileId}${grant ? `?grant=${grant}` : ''}`;

  it('metadata hides files until unlocked; downloads need a grant', async () => {
    const meta = (await (await fetch(`${t.base}/api/transfers/${ready.key}`)).json()) as any;
    assert.equal(meta.protected, true);
    assert.equal(meta.files, null);

    const noGrant = await fetch(fileUrl(ready, 0));
    assert.equal(noGrant.status, 401);
    assert.equal(await errCode(noGrant), 'password_required');
    const badGrant = await fetch(fileUrl(ready, 0, 'garbage'));
    assert.equal(badGrant.status, 401);
    const zip = await fetch(`${t.base}/api/transfers/${ready.key}/zip`);
    assert.equal(zip.status, 401);
    assert.equal(await errCode(zip), 'password_required');    for (const url of [fileUrl(ready, 0), `${t.base}/api/transfers/${ready.key}/zip`]) {
      assert.equal((await fetch(url, { method: 'HEAD' })).status, 401, `HEAD ${url}`);
    }
  });

  it('a wrong password is 401 wrong_password; the right one returns a grant and the files', async () => {
    const wrong = await unlock(ready.key, 'nope-nope');
    assert.equal(wrong.status, 401);
    assert.equal(await errCode(wrong), 'wrong_password');

    const res = await unlock(ready.key.toLowerCase(), 'pw123456');
    assert.equal(res.status, 200);
    const u = (await res.json()) as any;
    assert.match(u.grant, /^[A-Za-z0-9_-]+$/);
    assert.deepEqual(u.files, ready.files);

    const meta = (await (await fetch(`${t.base}/api/transfers/${ready.key}?grant=${u.grant}`)).json()) as any;
    assert.deepEqual(meta.files, ready.files);
  });

  it('a grant downloads the original bytes, single files and zip', async () => {
    const grant = await grantFor(ready.key, 'pw123456');
    const res = await fetch(fileUrl(ready, 0, grant));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-length'), null);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.ok((await body(res)).equals(secret));

    const zip = await fetch(`${t.base}/api/transfers/${ready.key}/zip?grant=${grant}`);
    assert.equal(zip.status, 200);
    const z = await body(zip);
    assert.ok(z.includes(secret));
    assert.ok(z.includes(second));
  });

  it('a protected zero-byte file downloads as an empty 200', async () => {
    const { ready: empty } = await share(t, [{ name: 'e', data: Buffer.alloc(0) }], {
      password: 'pw123456',
      f: sender.fetch.bind(sender),
    });
    const res = await fetch(fileUrl(empty, 0, await grantFor(empty.key, 'pw123456')));
    assert.equal(res.status, 200);
    assert.equal((await body(res)).length, 0);
  });

  it('a grant for another transfer is refused', async () => {
    const otherGrant = await grantFor(other.key, 'other-pass');
    const res = await fetch(fileUrl(ready, 0, otherGrant));
    assert.equal(res.status, 401);
    assert.equal(await errCode(res), 'password_required');
    const meta = (await (await fetch(`${t.base}/api/transfers/${ready.key}?grant=${otherGrant}`)).json()) as any;
    assert.equal(meta.files, null);
  });

  it('a grant expires after 15 minutes', async () => {
    const grant = await grantFor(ready.key, 'pw123456');
    assert.equal((await fetch(fileUrl(ready, 1, grant))).status, 200);
    skew += 16 * 60_000;
    try {
      const res = await fetch(fileUrl(ready, 1, grant));
      assert.equal(res.status, 401);
      assert.equal(await errCode(res), 'password_required');
    } finally {
      skew -= 16 * 60_000;
    }
  });

  it('a tampered file never downloads as complete', async () => {
    const { ready: r, transferId } = await share(t, [{ name: 'tamper.bin', data: randomBytes(200_000) }, { name: 'ok', data: Buffer.from('ok') }], {
      password: 'pw123456',
      f: sender.fetch.bind(sender),
    });
    const onDisk = path.join(t.deps.config.dataDir, 'files', transferId, r.files[0]!.fileId);
    const bytes = fs.readFileSync(onDisk);
    bytes[1000] = bytes[1000]! ^ 0xff;
    fs.writeFileSync(onDisk, bytes);
    const grant = await grantFor(r.key, 'pw123456');

    const logged: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void logged.push(args);
    try {
      for (const url of [fileUrl(r, 0, grant), `${t.base}/api/transfers/${r.key}/zip?grant=${grant}`]) {
        logged.length = 0;
        const res = await fetch(url);
        assert.equal(res.status, 200, url);
        await assert.rejects(res.arrayBuffer(), url);
        await new Promise((resolve) => setTimeout(resolve, 20)); // the server logs after tearing down
        assert.equal(logged.length, 1, url); // an integrity failure is logged, once
      }
    } finally {
      console.error = original;
    }
  });
});

describe('file names', () => {
  let t: TestApp;
  before(async () => {
    t = await makeTestApp();
  });
  after(() => t.close());

  it('sends safe attachment names and writes nothing outside the transfer directory', async () => {
    const { ready, transferId } = await share(t, [
      { name: 'тест.txt', data: Buffer.from('1') },
      { name: 'a"b.txt', data: Buffer.from('2') },
      { name: '../x', data: Buffer.from('3') },
    ]);
    const disposition = async (i: number) =>
      (await fetch(`${t.base}/api/transfers/${ready.key}/files/${ready.files[i]!.fileId}`)).headers.get('content-disposition')!;
    assert.ok((await disposition(0)).includes("filename*=UTF-8''%D1%82%D0%B5%D1%81%D1%82.txt"));
    const quoted = await disposition(1);
    assert.match(quoted, /^attachment; filename="?a_b\.txt"?$/);
    const traversal = await disposition(2);
    assert.match(traversal, /^attachment; filename="?x"?$/);

    const dataDir = t.deps.config.dataDir;
    assert.deepEqual(fs.readdirSync(path.join(dataDir, 'files')), [transferId]);
    assert.deepEqual(
      fs.readdirSync(path.join(dataDir, 'files', transferId)).sort(),
      ready.files.map((f) => f.fileId).sort(),
    );
    assert.ok(!fs.readdirSync(dataDir).includes('x'));
    assert.ok(!fs.existsSync(path.join(path.dirname(dataDir), 'x')));
  });
});

describe('owner management', () => {
  let t: TestApp;
  before(async () => {
    t = await makeTestApp();
  });
  after(() => t.close());

  it('lists own ready transfers newest first; only the owner deletes', async () => {
    const alice = await signedIn(t);
    const bob = await signedIn(t);
    const af = alice.fetch.bind(alice);
    const { ready: first } = await share(t, [{ name: 'one', data: Buffer.from('1') }], { f: af });
    await new Promise((r) => setTimeout(r, 5));
    const { ready: second, transferId } = await share(t, [{ name: 'two', data: Buffer.from('2') }], { f: af, password: 'pw123456' });
    await share(t, [{ name: 'bob', data: Buffer.from('b') }], { f: bob.fetch.bind(bob) });
    await share(t, [{ name: 'anon', data: Buffer.from('a') }]);

    const anon = await fetch(`${t.base}/api/me/transfers`);
    assert.equal(anon.status, 401);
    assert.equal(await errCode(anon), 'auth_required');
    const me = await fetch(`${t.base}/api/me`); // the auth route still answers
    assert.deepEqual(await me.json(), { user: null });

    const list = (await (await alice.fetch(`${t.base}/api/me/transfers`)).json()) as any;
    assert.deepEqual(list.transfers, [second, first]);
    const bobs = (await (await bob.fetch(`${t.base}/api/me/transfers`)).json()) as any;
    assert.deepEqual(bobs.transfers.map((r: Ready) => r.files[0]!.name), ['bob']);

    const del = (f: Fetch) => f(`${t.base}/api/transfers/${second.key}`, { method: 'DELETE' });
    const loggedOut = await del(fetch);
    assert.equal(loggedOut.status, 401);
    assert.equal(await errCode(loggedOut), 'auth_required');
    const notOwner = await del(bob.fetch.bind(bob));
    assert.equal(notOwner.status, 404);
    assert.equal(await errCode(notOwner), 'not_found');
    assert.equal((await fetch(`${t.base}/api/transfers/${second.key}`)).status, 200);

    const owner = await del(af);
    assert.equal(owner.status, 204);
    const gone = await fetch(`${t.base}/api/transfers/${second.key}`);
    assert.equal(gone.status, 404);
    assert.equal(await errCode(gone), 'not_found');
    assert.ok(!fs.existsSync(path.join(t.deps.config.dataDir, 'files', transferId)));
    const after = (await (await alice.fetch(`${t.base}/api/me/transfers`)).json()) as any;
    assert.deepEqual(after.transfers, [first]);
  });
});

describe('key guessing', () => {
  let t: TestApp;
  before(async () => {
    t = await makeTestApp({ rateLimits: { miss: 3 } });
  });
  after(() => t.close());

  it('failed key requests are throttled on every key route; successful downloads are not', async () => {
    const { ready } = await share(t, [{ name: 'x', data: Buffer.from('x') }]);
    for (let i = 0; i < 5; i++) {
      const ok = await fetch(`${t.base}/api/transfers/${ready.key}/files/${ready.files[0]!.fileId}`);
      assert.equal(ok.status, 200);
      await ok.arrayBuffer();
    }
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${t.base}/api/transfers/ZZZZZ${i + 2}/zip`);
      assert.equal(res.status, 404);
      await res.arrayBuffer();
    }
    const urls: [string, RequestInit?][] = [
      [`/api/transfers/ZZZZZZ/zip`],
      [`/api/transfers/ZZZZZZ`],
      [`/api/transfers/ZZZZZZ/unlock`, postJson({ password: 'x' })],
      [`/api/transfers/ZZZZZZ/files/x`],
      [`/api/transfers/ZZZZZZ`, { method: 'DELETE' }],
      [`/api/transfers/${ready.key}/files/${ready.files[0]!.fileId}`],
    ];
    for (const [url, init] of urls) {
      const res = await fetch(`${t.base}${url}`, init);
      assert.equal(res.status, 429, url);
      assert.equal(await errCode(res), 'rate_limited');
    }
  });
});

describe('aborted downloads and the miss budget', () => {
  let t: TestApp;
  before(async () => {
    t = await makeTestApp({ rateLimits: { miss: 2 } });
  });
  after(() => t.close());

  it('a download the client aborts mid-stream does not use up the miss budget', async () => {
    const { ready } = await share(t, [{ name: 'big', data: randomBytes(24 * MB) }]);
    const url = `${t.base}/api/transfers/${ready.key}/files/${ready.files[0]!.fileId}`;
    for (let i = 0; i < 4; i++) {
      const ctl = new AbortController();
      const res = await fetch(url, { signal: ctl.signal });
      assert.equal(res.status, 200);
      const reader = res.body!.getReader();
      await reader.read();
      ctl.abort();
      await reader.read().catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 200)); // the server notices the closed sockets
    const miss = await fetch(`${t.base}/api/transfers/ZZZZZZ`);
    assert.equal(miss.status, 404);
    await miss.arrayBuffer();
    const ok = await fetch(url);
    assert.equal(ok.status, 200);
    await ok.arrayBuffer();
  });
});
