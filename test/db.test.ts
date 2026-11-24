import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { openDb } from '../src/db/client.ts';
import { DrizzleSessionStore } from '../src/db/sessionStore.ts';
import { transferFiles, transfers } from '../src/db/schema.ts';
import type { SessionData } from 'express-session';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fx-db-'));
}

function tableNames(db: ReturnType<typeof openDb>['db']): string[] {
  return db.all<{ name: string }>(sql`select name from sqlite_master where type = 'table'`).map((r) => r.name);
}

test('openDb creates app.db with all tables and is idempotent', () => {
  const dir = path.join(tmpDir(), 'nested');
  try {
    const first = openDb(dir);
    assert.ok(fs.existsSync(path.join(dir, 'app.db')));
    const names = tableNames(first.db);
    for (const t of ['users', 'email_tokens', 'transfers', 'transfer_files', 'sessions']) {
      assert.ok(names.includes(t), `missing table ${t}`);
    }
    first.close();
    const second = openDb(dir);
    assert.ok(tableNames(second.db).includes('users'));
    second.close();
  } finally {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test('deleting a transfer cascades its files', () => {
  const dir = tmpDir();
  try {
    const { db, close } = openDb(dir);
    const now = new Date();
    db.insert(transfers).values({
      id: 't1', uploadTokenHash: 'h', status: 'ready', totalSize: 3, createdAt: now, expiresAt: now,
    }).run();
    db.insert(transferFiles).values({
      id: 'f1', transferId: 't1', originalName: 'a.txt', storedName: 'f1', size: 3, mime: 'text/plain', position: 0,
    }).run();
    db.delete(transfers).where(eq(transfers.id, 't1')).run();
    assert.equal(db.select().from(transferFiles).all().length, 0);
    close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('session store round-trips, expires and destroys', async () => {
  const dir = tmpDir();
  try {
    const { db, close } = openDb(dir);
    let now = 1_000_000;
    const store = new DrizzleSessionStore(db, () => now);
    const sess = { cookie: { originalMaxAge: null }, userId: 7 } as unknown as SessionData;
    await new Promise<void>((res, rej) => store.set('s1', sess, (e) => (e ? rej(e) : res())));
    const got = await new Promise<SessionData | null | undefined>((res, rej) =>
      store.get('s1', (e, s) => (e ? rej(e) : res(s))));
    assert.deepEqual(got, sess);

    now += 2 * 3600_000;
    const expired = await new Promise<SessionData | null | undefined>((res, rej) =>
      store.get('s1', (e, s) => (e ? rej(e) : res(s))));
    assert.equal(expired, null);

    now = 1_000_000;
    await new Promise<void>((res, rej) => store.set('s2', sess, (e) => (e ? rej(e) : res())));
    await new Promise<void>((res, rej) => store.destroy('s2', (e) => (e ? rej(e) : res())));
    const gone = await new Promise<SessionData | null | undefined>((res, rej) =>
      store.get('s2', (e, s) => (e ? rej(e) : res(s))));
    assert.equal(gone, null);
    close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
