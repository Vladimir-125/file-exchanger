import { eq } from 'drizzle-orm';
import type { Config } from '../config.ts';
import type { Db } from '../db/client.ts';
import { emailTokens, users, type User } from '../db/schema.ts';
import { HttpError } from '../errors.ts';
import { hashPassword, randomToken, sha256Hex, verifyPassword } from '../lib/crypto.ts';
import type { Mailer } from './mailer.ts';

const TOKEN_TTL_MS = 24 * 3600_000;

export type UserService = ReturnType<typeof createUserService>;

// verified against when the email is unknown, so login timing does not reveal which emails exist
const DUMMY_HASH = await hashPassword('dummy-password-for-timing');

export function createUserService({ db, mailer, now }: { db: Db; mailer: Mailer; config: Config; now: () => number }) {
  /** Issues a token carrying the credentials the signer-up chose; older tokens of the user are revoked. */
  function sendConfirmation(user: User, name: string, passwordHash: string, baseUrl: string): void {
    const token = randomToken();
    db.delete(emailTokens).where(eq(emailTokens.userId, user.id)).run();
    db.insert(emailTokens)
      .values({ tokenHash: sha256Hex(token), userId: user.id, name, passwordHash, expiresAt: new Date(now() + TOKEN_TTL_MS) })
      .run();
    // not awaited: response time and SMTP failures must not reveal whether the email is already confirmed
    void mailer
      .send({
        to: user.email,
        subject: 'Confirm your email',
        text: `Hi ${name},\n\nConfirm your email address to finish creating your account:\n\n${baseUrl}/confirm/${token}\n\nThe link is valid for 24 hours.`,
      })
      .catch((err) => console.error('failed to send confirmation mail', err));
  }

  return {
    async signup(input: { name: string; email: string; password: string }, baseUrl: string): Promise<void> {
      const email = input.email.trim().toLowerCase();
      const name = input.name.trim();
      const passwordHash = await hashPassword(input.password);
      // check-and-insert is synchronous (better-sqlite3), so no race after the await above
      let user = db.select().from(users).where(eq(users.email, email)).get();
      if (user?.confirmedAt) return;
      user ??= db.insert(users).values({ email, name, passwordHash, createdAt: new Date(now()) }).returning().get();
      sendConfirmation(user, name, passwordHash, baseUrl);
    },

    async confirm(token: string): Promise<number> {
      const row = db.select().from(emailTokens).where(eq(emailTokens.tokenHash, sha256Hex(token))).get();
      if (!row || row.expiresAt.getTime() <= now()) throw new HttpError(404, 'invalid_token', 'Invalid or expired link');
      db.delete(emailTokens).where(eq(emailTokens.userId, row.userId)).run();
      db.update(users)
        .set({ name: row.name, passwordHash: row.passwordHash, confirmedAt: new Date(now()) })
        .where(eq(users.id, row.userId))
        .run();
      return row.userId;
    },

    async login(email: string, password: string): Promise<User> {
      const user = db.select().from(users).where(eq(users.email, email.trim().toLowerCase())).get();
      const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
      if (!user || !ok) throw new HttpError(401, 'invalid_credentials', 'Wrong email or password');
      if (!user.confirmedAt) throw new HttpError(403, 'email_unconfirmed', 'Confirm your email first');
      return user;
    },

    get(id: number): User | undefined {
      return db.select().from(users).where(eq(users.id, id)).get();
    },
  };
}
