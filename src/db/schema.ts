import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

const ts = (name: string) => integer(name, { mode: 'timestamp_ms' });

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  confirmedAt: ts('confirmed_at'),
  createdAt: ts('created_at').notNull(),
});

export const emailTokens = sqliteTable('email_tokens', {
  tokenHash: text('token_hash').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: ts('expires_at').notNull(),
});

export const transfers = sqliteTable('transfers', {
  id: text('id').primaryKey(),
  key: text('key').unique(),
  ownerId: integer('owner_id').references(() => users.id, { onDelete: 'set null' }),
  passwordHash: text('password_hash'),
  encSalt: text('enc_salt'),
  uploadTokenHash: text('upload_token_hash').notNull(),
  status: text('status', { enum: ['uploading', 'ready'] }).notNull(),
  totalSize: integer('total_size').notNull(),
  createdAt: ts('created_at').notNull(),
  expiresAt: ts('expires_at').notNull(),
});

export const transferFiles = sqliteTable('transfer_files', {
  id: text('id').primaryKey(),
  transferId: text('transfer_id').notNull().references(() => transfers.id, { onDelete: 'cascade' }),
  originalName: text('original_name').notNull(),
  storedName: text('stored_name').notNull(),
  size: integer('size').notNull(),
  mime: text('mime').notNull(),
  position: integer('position').notNull(),
});

export const sessions = sqliteTable('sessions', {
  sid: text('sid').primaryKey(),
  data: text('data').notNull(),
  expiresAt: ts('expires_at').notNull(),
});

export type User = typeof users.$inferSelect;
export type Transfer = typeof transfers.$inferSelect;
export type TransferFile = typeof transferFiles.$inferSelect;
