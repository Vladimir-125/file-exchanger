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

  it('without BASE_URL the link uses the Host header, never X-Forwarded-Host', async () => {
    const res = await fetch(`${t.base}/api/auth/signup`, {
      ...postJson({ ...creds, email: 'xfh@example.com' }),
      headers: { 'content-type': 'application/json', 'x-forwarded-host': 'evil.example' },
    });
    assert.equal(res.status, 202);
    const text = t.mail.pop()!.text;
    assert.ok(text.includes(`${t.base}/confirm/`));
    assert.ok(!text.includes('evil.example'));
  });

  it('signup again while unconfirmed re-sends the link', async () => {
    const res = await fetch(`${t.base}/api/auth/signup`, postJson(creds));
    assert.equal(res.status, 202);
    assert.equal(t.mail.length, 2);
    confirmPath = `/confirm/${tokenOf(t.mail[1])}`; // the first link is revoked
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
    assert.equal(((await empty.json()) as any).error.code, 'invalid_request');
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

const tokenOf = (m: { text: string }) => m.text.match(/\/confirm\/([A-Za-z0-9_-]{43})/)![1];

describe('account edge cases', () => {
  it('re-signup binds the new password to the new link (no pre-hijack)', async () => {
    const t = await makeTestApp();
    try {
      const email = 'bob@example.com';
      await fetch(`${t.base}/api/auth/signup`, postJson({ name: 'Bob', email, password: 'attacker-pass' }));
      await fetch(`${t.base}/api/auth/signup`, postJson({ name: 'Bob', email, password: 'victim-pass1' }));
      assert.equal(t.mail.length, 2);
      const [first, second] = t.mail.map(tokenOf);
      assert.equal((await fetch(`${t.base}/confirm/${first}`, { redirect: 'manual' })).status, 404);
      const jar = cookieJar();
      assert.equal((await jar.fetch(`${t.base}/confirm/${second}`)).status, 302);
      const a = await fetch(`${t.base}/api/auth/login`, postJson({ email, password: 'attacker-pass' }));
      assert.equal(a.status, 401);
      const b = await fetch(`${t.base}/api/auth/login`, postJson({ email, password: 'victim-pass1' }));
      assert.equal(b.status, 200);
    } finally {
      await t.close();
    }
  });

  it('the re-sent link confirms', async () => {
    const t = await makeTestApp();
    try {
      const body = { name: 'Cy', email: 'cy@example.com', password: 'password1' };
      await fetch(`${t.base}/api/auth/signup`, postJson(body));
      await fetch(`${t.base}/api/auth/signup`, postJson(body));
      const res = await fetch(`${t.base}/confirm/${tokenOf(t.mail[1])}`, { redirect: 'manual' });
      assert.equal(res.status, 302);
    } finally {
      await t.close();
    }
  });

  it('an expired link is 404', async () => {
    let now = 1_700_000_000_000;
    const t = await makeTestApp({ now: () => now });
    try {
      await fetch(`${t.base}/api/auth/signup`, postJson({ name: 'Di', email: 'di@example.com', password: 'password1' }));
      now += 24 * 3600_000 + 1;
      const res = await fetch(`${t.base}/confirm/${tokenOf(t.mail[0])}`, { redirect: 'manual' });
      assert.equal(res.status, 404);
    } finally {
      await t.close();
    }
  });

  it('login with an unknown email is 401', async () => {
    const t = await makeTestApp();
    try {
      const res = await fetch(`${t.base}/api/auth/login`, postJson({ email: 'ghost@example.com', password: 'password1' }));
      assert.equal(res.status, 401);
      assert.equal(((await res.json()) as any).error.code, 'invalid_credentials');
    } finally {
      await t.close();
    }
  });

  it('login issues a new session id', async () => {
    const t = await makeTestApp();
    try {
      const body = { name: 'Ed', email: 'ed@example.com', password: 'password1' };
      await fetch(`${t.base}/api/auth/signup`, postJson(body));
      const jar = cookieJar();
      await jar.fetch(`${t.base}/confirm/${tokenOf(t.mail[0])}`);
      const sid = () => jar.cookie('fx_sid');
      const before = sid();
      assert.ok(before);
      await jar.fetch(`${t.base}/api/auth/logout`, { method: 'POST' });
      // pre-login session that is not authenticated
      await jar.fetch(`${t.base}/api/auth/login`, postJson(body));
      assert.notEqual(sid(), before);
      const mid = sid();
      await jar.fetch(`${t.base}/api/auth/login`, postJson(body));
      assert.notEqual(sid(), mid);
    } finally {
      await t.close();
    }
  });

  it('pages and API responses carry the security headers', async () => {
    const csp =
      "default-src 'self'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; frame-ancestors 'none'; " +
      "base-uri 'none'; form-action 'self'; object-src 'none'";
    const t = await makeTestApp();
    try {
      for (const url of [`${t.base}/`, `${t.base}/K7PX3M`, `${t.base}/api/config`, `${t.base}/api/nope`]) {
        const res = await fetch(url);
        assert.equal(res.headers.get('content-security-policy'), csp, url);
        assert.equal(res.headers.get('referrer-policy'), 'no-referrer', url);
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff', url);
      }
    } finally {
      await t.close();
    }
  });

  it('unknown /api paths are a JSON 404; /confirm/x is the token page', async () => {
    const t = await makeTestApp();
    try {
      const nope = await fetch(`${t.base}/api/nope`);
      assert.equal(nope.status, 404);
      assert.equal(((await nope.json()) as any).error.code, 'not_found');
      const c = await fetch(`${t.base}/confirm/x`, { redirect: 'manual' });
      assert.equal(c.status, 404);
      assert.doesNotMatch(await c.text(), /<title>/);
      const me = await fetch(`${t.base}/api/me`);
      assert.equal(me.status, 200);
      assert.deepEqual(await me.json(), { user: null });
    } finally {
      await t.close();
    }
  });
});

describe('signup mail failures', () => {
  it('a failing mailer still yields 202', async () => {
    const t = await makeTestApp();
    const orig = console.error;
    console.error = () => {};
    try {
      t.deps.mailer.send = async () => {
        throw new Error('smtp down');
      };
      const res = await fetch(
        `${t.base}/api/auth/signup`,
        postJson({ name: 'Fy', email: 'fy@example.com', password: 'password1' }),
      );
      assert.equal(res.status, 202);
    } finally {
      console.error = orig;
      await t.close();
    }
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
