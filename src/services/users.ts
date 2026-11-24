import { eq } from 'drizzle-orm';
import type { Config } from '../config.ts';
import type { Db } from '../db/client.ts';
import { emailTokens, users, type User } from '../db/schema.ts';
import { HttpError } from '../errors.ts';
import { hashPassword, randomToken, sha256Hex, verifyPassword } from '../lib/crypto.ts';
import type { Mailer } from './mailer.ts';

const TOKEN_TTL_MS = 24 * 3600_000;

export type UserService = ReturnType<typeof createUserService>;

export function createUserService({ db, mailer, now }: { db: Db; mailer: Mailer; config: Config; now: () => number }) {
  async function sendConfirmation(user: User, baseUrl: string): Promise<void> {
    const token = randomToken();
    db.insert(emailTokens)
      .values({ tokenHash: sha256Hex(token), userId: user.id, expiresAt: new Date(now() + TOKEN_TTL_MS) })
      .run();
    await mailer.send({
      to: user.email,
      subject: 'Confirm your email',
      text: `Hi ${user.name},\n\nConfirm your email address to finish creating your account:\n\n${baseUrl}/confirm/${token}\n\nThe link is valid for 24 hours.`,
    });
  }

  return {
    async signup(input: { name: string; email: string; password: string }, baseUrl: string): Promise<void> {
      const email = input.email.trim().toLowerCase();
      const passwordHash = await hashPassword(input.password);
      // check-and-insert is synchronous (better-sqlite3), so no race after the await above
      let user = db.select().from(users).where(eq(users.email, email)).get();
      if (user?.confirmedAt) return;
      if (!user) {
        user = db
          .insert(users)
          .values({ email, name: input.name.trim(), passwordHash, createdAt: new Date(now()) })
          .returning()
          .get();
      }
      await sendConfirmation(user, baseUrl);
    },

    async confirm(token: string): Promise<number> {
      const row = db.select().from(emailTokens).where(eq(emailTokens.tokenHash, sha256Hex(token))).get();
      if (!row || row.expiresAt.getTime() <= now()) throw new HttpError(404, 'invalid_token', 'Invalid or expired link');
      db.delete(emailTokens).where(eq(emailTokens.tokenHash, row.tokenHash)).run();
      const user = db.select().from(users).where(eq(users.id, row.userId)).get();
      if (!user) throw new HttpError(404, 'invalid_token', 'Invalid or expired link');
      if (!user.confirmedAt) db.update(users).set({ confirmedAt: new Date(now()) }).where(eq(users.id, user.id)).run();
      return user.id;
    },

    async login(email: string, password: string): Promise<User> {
      const user = db.select().from(users).where(eq(users.email, email.trim().toLowerCase())).get();
      if (!user || !(await verifyPassword(password, user.passwordHash))) {
        throw new HttpError(401, 'invalid_credentials', 'Wrong email or password');
      }
      if (!user.confirmedAt) throw new HttpError(403, 'email_unconfirmed', 'Confirm your email first');
      return user;
    },

    get(id: number): User | undefined {
      return db.select().from(users).where(eq(users.id, id)).get();
    },
  };
}
