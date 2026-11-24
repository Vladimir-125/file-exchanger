import session from 'express-session';
import { eq } from 'drizzle-orm';
import type { Db } from './client.ts';
import { sessions } from './schema.ts';

const DEFAULT_TTL_MS = 3600_000;

export class DrizzleSessionStore extends session.Store {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    super();
  }

  private expiryOf(sess: session.SessionData): Date {
    const expires = sess.cookie?.expires;
    return expires ? new Date(expires) : new Date(this.now() + DEFAULT_TTL_MS);
  }

  override get(sid: string, cb: (err?: unknown, session?: session.SessionData | null) => void): void {
    let result: session.SessionData | null;
    try {
      const row = this.db.select().from(sessions).where(eq(sessions.sid, sid)).get();
      if (!row) {
        result = null;
      } else if (row.expiresAt.getTime() <= this.now()) {
        this.db.delete(sessions).where(eq(sessions.sid, sid)).run();
        result = null;
      } else {
        result = JSON.parse(row.data) as session.SessionData;
      }
    } catch (err) {
      return cb(err);
    }
    cb(null, result);
  }

  override set(sid: string, sess: session.SessionData, cb?: (err?: unknown) => void): void {
    try {
      const values = { data: JSON.stringify(sess), expiresAt: this.expiryOf(sess) };
      this.db.insert(sessions).values({ sid, ...values }).onConflictDoUpdate({ target: sessions.sid, set: values }).run();
    } catch (err) {
      return cb?.(err);
    }
    cb?.();
  }

  override destroy(sid: string, cb?: (err?: unknown) => void): void {
    try {
      this.db.delete(sessions).where(eq(sessions.sid, sid)).run();
    } catch (err) {
      return cb?.(err);
    }
    cb?.();
  }

  override touch(sid: string, sess: session.SessionData, cb?: (err?: unknown) => void): void {
    try {
      this.db.update(sessions).set({ expiresAt: this.expiryOf(sess) }).where(eq(sessions.sid, sid)).run();
    } catch (err) {
      return cb?.(err);
    }
    cb?.();
  }
}
