import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { cookieJar, makeTestApp, postJson, type TestApp } from './helpers.ts';

const creds = { name: 'Ann', email: 'ann@example.com', password: 'correct horse' };

describe('accounts', () => {
  let t: TestApp;
  const jar = cookieJar();
  let confirmPath = '';

  before(async () => {
    t = await makeTestApp();
  });
  after(() => t.close());

  it('signup sends one confirmation mail', async () => {
    const res = await fetch(`${t.base}/api/auth/signup`, postJson(creds));
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(t.mail.length, 1);
    assert.equal(t.mail[0].to, 'ann@example.com');
    const m = t.mail[0].text.match(/\/confirm\/([A-Za-z0-9_-]{43})(?!\S)/);
    assert.ok(m, 'mail has a 43-char confirm link');
    assert.ok(t.mail[0].text.includes(`${t.base}/confirm/`));
    confirmPath = `/confirm/${m[1]}`;
  });

  it('signup again while unconfirmed re-sends the link', async () => {
    const res = await fetch(`${t.base}/api/auth/signup`, postJson(creds));
    assert.equal(res.status, 202);
    assert.equal(t.mail.length, 2);
    t.mail.pop();
  });

  it('login before confirm is 403', async () => {
    const res = await fetch(`${t.base}/api/auth/login`, postJson(creds));
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as any).error.code, 'email_unconfirmed');
  });

  it('confirm redirects to / and signs in', async () => {
    const res = await jar.fetch(`${t.base}${confirmPath}`);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/');
    assert.match(res.headers.get('set-cookie') ?? '', /fx_sid=/);
    const me = await jar.fetch(`${t.base}/api/me`);
    assert.deepEqual(await me.json(), { user: { id: 1, name: 'Ann', email: 'ann@example.com' } });
  });

  it('a link works only once', async () => {
    const res = await fetch(`${t.base}${confirmPath}`, { redirect: 'manual' });
    assert.equal(res.status, 404);
  });

  it('wrong password is 401', async () => {
    const res = await fetch(`${t.base}/api/auth/login`, postJson({ ...creds, password: 'nope nope' }));
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as any).error.code, 'invalid_credentials');
  });

  it('signup with a confirmed email is 202 and sends nothing', async () => {
    const before = t.mail.length;
    const res = await fetch(`${t.base}/api/auth/signup`, postJson(creds));
    assert.equal(res.status, 202);
    assert.equal(t.mail.length, before);
  });

  it('login works and logout clears the session', async () => {
    const j = cookieJar();
    const login = await j.fetch(`${t.base}/api/auth/login`, postJson(creds));
    assert.equal(login.status, 200);
    assert.equal(((await login.json()) as any).user.email, 'ann@example.com');
    assert.equal(((await (await j.fetch(`${t.base}/api/me`)).json()) as any).user.name, 'Ann');
    assert.equal((await j.fetch(`${t.base}/api/auth/logout`, { method: 'POST' })).status, 204);
    assert.deepEqual(await (await j.fetch(`${t.base}/api/me`)).json(), { user: null });
  });

  it('rejects invalid input with 400', async () => {
    const short = await fetch(`${t.base}/api/auth/signup`, postJson({ ...creds, password: 'short' }));
    assert.equal(short.status, 400);
    assert.equal(((await short.json()) as any).error.code, 'invalid_request');
    const empty = await fetch(`${t.base}/api/auth/login`, { method: 'POST' });
    assert.equal(empty.status, 400);
    const bad = await fetch(`${t.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{nope',
    });
    assert.equal(bad.status, 400);
  });

  it('serves config and the SPA page', async () => {
    const cfg = (await (await fetch(`${t.base}/api/config`)).json()) as any;
    assert.equal(cfg.keyLength, 6);
    assert.ok(Array.isArray(cfg.iceServers));
    const page = await fetch(`${t.base}/K7PX3M`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>File Exchanger<\/title>/);
  });
});

describe('rate limits', () => {
  it('answers 429 in the JSON error shape', async () => {
    const t = await makeTestApp({ rateLimits: { auth: 2 } });
    try {
      for (let i = 0; i < 2; i++) {
        const r = await fetch(`${t.base}/api/auth/login`, postJson({ email: 'x@y.z', password: 'whatever1' }));
        assert.equal(r.status, 401);
      }
      const res = await fetch(`${t.base}/api/auth/login`, postJson({ email: 'x@y.z', password: 'whatever1' }));
      assert.equal(res.status, 429);
      const body = (await res.json()) as any;
      assert.equal(body.error.code, 'rate_limited');
      assert.equal(typeof body.error.message, 'string');
    } finally {
      await t.close();
    }
  });
});
