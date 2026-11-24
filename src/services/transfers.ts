import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { and, asc, eq, lte, or, sql } from 'drizzle-orm';
import type { Config } from '../config.ts';
import type { Db } from '../db/client.ts';
import { sessions, transferFiles, transfers, type Transfer, type TransferFile } from '../db/schema.ts';
import { HttpError } from '../errors.ts';
import { deriveFileKey, encryptFile, hashPassword, newSaltHex, randomToken, sha256Hex } from '../lib/crypto.ts';
import { safeDisplayName } from '../lib/fileName.ts';
import { generateKey, normalizeKey } from '../lib/keys.ts';

/** Implemented by the WebRTC signaling hub (Task 8). */
export type Signaling = {
  isLive(key: string): boolean;
  claimLiveKey(key: string, liveToken: string): boolean;
  notifyStored(key: string): void;
};

export type CreateInput = { files: { name: string; size: number; mime?: string }[]; password?: string; ownerId?: number };
export type PublicFile = { fileId: string; name: string; size: number };
export type CreateResult = { transferId: string; uploadToken: string; chunkBytes: number; files: PublicFile[] };
export type ReadyTransfer = { key: string; url: string; expiresAt: number; protected: boolean; files: PublicFile[] };
export type TransferRecord = { transfer: Transfer; files: TransferFile[] };
export type CompleteOpts = { liveKey?: string; liveToken?: string; baseUrl?: string };
export type TransferService = ReturnType<typeof createTransferService>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_MIME = 100;

/** Per-upload state that only lives in memory: lost on restart, so such uploads cannot complete. */
type UploadState = {
  password?: string;
  received: Map<string, Set<number>>; // fileId -> chunk indexes fully written
  inflight: number;
  completing: boolean;
  lastActivity: number;
};

const notFound = () => new HttpError(404, 'not_found', 'Transfer not found');
const incomplete = () => new HttpError(409, 'incomplete', 'Not every file has been fully uploaded');
const notUploading = () => new HttpError(409, 'not_uploading', 'Transfer is not accepting uploads');
const uploadLost = () =>
  new HttpError(409, 'upload_lost', 'The server restarted during this upload; start a new transfer');

function tokenMatches(token: string, storedHash: string): boolean {
  const a = Buffer.from(sha256Hex(token));
  const b = Buffer.from(storedHash);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createTransferService({
  db,
  config,
  now,
  signaling,
}: {
  db: Db;
  config: Config;
  now: () => number;
  signaling?: Signaling;
}) {
  const uploads = new Map<string, UploadState>();
  const dirOf = (transferId: string) => path.join(config.dataDir, 'files', transferId);
  const chunkCount = (size: number) => Math.ceil(size / config.chunkBytes);

  /** Loads an uploading transfer the token opens; ids are checked to be UUIDs before any lookup. */
  function uploadingTransfer(transferId: string, uploadToken: string): Transfer {
    if (!UUID.test(transferId)) throw notFound();
    const row = db.select().from(transfers).where(eq(transfers.id, transferId)).get();
    if (!row) throw notFound();
    if (!tokenMatches(uploadToken, row.uploadTokenHash)) throw new HttpError(403, 'bad_token', 'Invalid upload token');
    if (row.status !== 'uploading') throw notUploading();
    return row;
  }

  function stateOf(row: Transfer): UploadState | undefined {
    let state = uploads.get(row.id);
    // after a restart an unprotected upload can be resumed by re-sending every chunk
    if (!state && !row.passwordHash) {
      state = { received: new Map(), inflight: 0, completing: false, lastActivity: now() };
      uploads.set(row.id, state);
    }
    return state;
  }

  async function remove(transferId: string): Promise<void> {
    if (!UUID.test(transferId)) throw notFound(); // never let an id reach a recursive rm
    await fs.rm(dirOf(transferId), { recursive: true, force: true });
    db.delete(transfers).where(eq(transfers.id, transferId)).run();
    uploads.delete(transferId);
  }

  return {
    async create(input: CreateInput): Promise<CreateResult> {
      const { files } = input;
      if (files.length < 1 || files.length > config.maxFilesPerTransfer) {
        throw new HttpError(400, 'too_many_files', `A transfer holds 1 to ${config.maxFilesPerTransfer} files`);
      }
      for (const f of files) {
        if (!Number.isSafeInteger(f.size) || f.size < 0 || f.size > config.maxFileBytes) {
          throw new HttpError(400, 'file_too_large', 'A file is larger than the per-file limit');
        }
      }
      const total = files.reduce((s, f) => s + f.size, 0);
      if (total > config.maxTransferBytes) {
        throw new HttpError(400, 'transfer_too_large', 'The files together are larger than the transfer limit');
      }
      if (input.password !== undefined && input.ownerId === undefined) {
        throw new HttpError(401, 'auth_required', 'Sign in to protect a transfer with a password');
      }

      // every await happens before the cap check: the check and the inserts below run in one
      // synchronous transaction, so concurrent creates cannot both pass the cap
      const passwordHash = input.password === undefined ? null : await hashPassword(input.password);
      const encSalt = input.password === undefined ? null : newSaltHex();

      const transferId = randomUUID();
      const uploadToken = randomToken();
      const fileRows = files.map((f, position) => {
        const id = randomUUID();
        return {
          id,
          transferId,
          originalName: safeDisplayName(f.name),
          storedName: id,
          size: f.size,
          mime: (f.mime || 'application/octet-stream').slice(0, MAX_MIME),
          position,
        };
      });
      const t = now();
      db.transaction((tx) => {
        const used = tx
          .select({ sum: sql<number>`coalesce(sum(${transfers.totalSize}), 0)` })
          .from(transfers)
          .get()!.sum;
        if (used + total > config.storageCapBytes) {
          throw new HttpError(507, 'storage_full', 'The server is out of storage space, try again later');
        }
        tx.insert(transfers)
          .values({
            id: transferId,
            ownerId: input.ownerId ?? null,
            passwordHash,
            encSalt,
            uploadTokenHash: sha256Hex(uploadToken),
            status: 'uploading',
            totalSize: total,
            createdAt: new Date(t),
            expiresAt: new Date(t + config.transferTtlMs),
          })
          .run();
        tx.insert(transferFiles).values(fileRows).run();
      });

      try {
        const dir = dirOf(transferId);
        await fs.mkdir(dir, { recursive: true });
        await Promise.all(fileRows.map((f) => fs.writeFile(path.join(dir, `${f.storedName}.part`), '')));
      } catch (err) {
        await remove(transferId).catch(() => {});
        throw err;
      }
      uploads.set(transferId, {
        password: input.password,
        received: new Map(fileRows.map((f) => [f.id, new Set<number>()])),
        inflight: 0,
        completing: false,
        lastActivity: t,
      });

      return {
        transferId,
        uploadToken,
        chunkBytes: config.chunkBytes,
        files: fileRows.map((f) => ({ fileId: f.id, name: f.originalName, size: f.size })),
      };
    },

    /**
     * Streams one chunk to its offset in the file's `.part`. `declaredLength` (Content-Length)
     * lets an oversized chunk be refused before any byte is read.
     */
    async writeChunk(
      transferId: string,
      fileId: string,
      index: number,
      uploadToken: string,
      body: Readable,
      declaredLength?: number,
    ): Promise<void> {
      const row = uploadingTransfer(transferId, uploadToken);
      if (!UUID.test(fileId)) throw notFound();
      const file = db
        .select()
        .from(transferFiles)
        .where(and(eq(transferFiles.id, fileId), eq(transferFiles.transferId, transferId)))
        .get();
      if (!file) throw notFound();
      if (!Number.isSafeInteger(index) || index < 0 || index >= chunkCount(file.size)) {
        throw new HttpError(400, 'bad_chunk', 'Chunk index out of range');
      }
      const state = stateOf(row);
      if (!state) throw uploadLost();
      if (state.completing) throw notUploading();

      const start = index * config.chunkBytes;
      const expected = Math.min(config.chunkBytes, file.size - start);
      const tooLarge = () => new HttpError(413, 'chunk_too_large', `Chunk ${index} must be ${expected} bytes`);
      if (declaredLength !== undefined && declaredLength > expected) throw tooLarge();

      let received = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          received += chunk.length;
          // the overflowing piece is never passed on, so nothing is written past this chunk's range
          if (received > expected) return cb(tooLarge());
          cb(null, chunk);
        },
      });
      const out = createWriteStream(path.join(dirOf(transferId), `${file.storedName}.part`), { flags: 'r+', start });
      let fsError: unknown;
      // pipeline also destroys `out` with the body's error (client gone); only real fs errors carry a syscall
      out.on('error', (err: NodeJS.ErrnoException) => {
        if (err.syscall) fsError ??= err;
      });

      const chunks = state.received.get(fileId) ?? new Set<number>();
      state.received.set(fileId, chunks);
      chunks.delete(index); // being overwritten: not valid until this write finishes
      state.inflight++;
      state.lastActivity = now();
      try {
        await pipeline(body, counter, out);
      } catch (err) {
        if (err instanceof HttpError) throw err;
        if (fsError) throw fsError;
        throw new HttpError(400, 'aborted', 'The upload was interrupted'); // client went away
      } finally {
        state.inflight--;
        state.lastActivity = now();
      }
      if (received < expected) throw new HttpError(400, 'short_chunk', `Chunk ${index} must be ${expected} bytes`);
      chunks.add(index);
    },

    async complete(transferId: string, uploadToken: string, opts: CompleteOpts = {}): Promise<ReadyTransfer> {
      // opts.liveKey / opts.liveToken are claimed through signaling once it exists (Task 8)
      const row = uploadingTransfer(transferId, uploadToken);
      const state = stateOf(row);
      if (!state || (row.passwordHash && state.password === undefined)) throw uploadLost();
      if (state.completing) throw notUploading();
      if (state.inflight > 0) throw incomplete();
      const files = db
        .select()
        .from(transferFiles)
        .where(eq(transferFiles.transferId, transferId))
        .orderBy(asc(transferFiles.position))
        .all();
      for (const f of files) {
        const got = state.received.get(f.id);
        for (let i = 0; i < chunkCount(f.size); i++) if (!got?.has(i)) throw incomplete();
      }

      state.completing = true; // blocks new chunks and a second complete while files are finalised
      const dir = dirOf(transferId);
      let key: string;
      let expiresAt: number;
      try {
        for (const f of files) {
          const size = await fs.stat(path.join(dir, `${f.storedName}.part`)).then((s) => s.size, () => -1);
          if (size !== f.size) throw incomplete();
        }
        const fileKey = row.passwordHash ? await deriveFileKey(state.password!, row.encSalt!) : null;
        for (const f of files) {
          const part = path.join(dir, `${f.storedName}.part`);
          const final = path.join(dir, f.storedName);
          if (fileKey) {
            await encryptFile(part, final, fileKey);
            await fs.unlink(part);
          } else {
            await fs.rename(part, final);
          }
        }

        // key generation and the update are synchronous, so no other transfer can take the key meanwhile
        const isTaken = (k: string) =>
          signaling?.isLive(k) === true ||
          db.select({ id: transfers.id }).from(transfers).where(eq(transfers.key, k)).get() !== undefined;
        key = generateKey(config.keyLength, isTaken);
        expiresAt = now() + config.transferTtlMs; // the TTL counts from when the files become available
        db.update(transfers)
          .set({ status: 'ready', key, expiresAt: new Date(expiresAt) })
          .where(eq(transfers.id, transferId))
          .run();
      } catch (err) {
        state.completing = false; // otherwise cleanup would skip this transfer forever
        throw err;
      }
      uploads.delete(transferId);

      return {
        key,
        url: `${opts.baseUrl ?? config.baseUrl}/${key}`,
        expiresAt,
        protected: row.passwordHash !== null,
        files: files.map((f) => ({ fileId: f.id, name: f.originalName, size: f.size })),
      };
    },

    async findReady(input: string): Promise<TransferRecord | null> {
      const key = normalizeKey(input, config.keyLength);
      if (!key) return null;
      const transfer = db
        .select()
        .from(transfers)
        .where(and(eq(transfers.key, key), eq(transfers.status, 'ready')))
        .get();
      if (!transfer || transfer.expiresAt.getTime() <= now()) return null;
      const files = db
        .select()
        .from(transferFiles)
        .where(eq(transferFiles.transferId, transfer.id))
        .orderBy(asc(transferFiles.position))
        .all();
      return { transfer, files };
    },

    /** Absolute path of a ready file on disk. */
    filePath(file: TransferFile): string {
      return path.join(dirOf(file.transferId), file.storedName);
    },

    remove,

    async cleanup(): Promise<number> {
      const t = now();
      const abandonedBefore = new Date(t - config.uploadAbandonMs);
      // hard ceiling: an upload cannot hold its storage reservation longer than a ready transfer lives
      const tooOld = t - config.transferTtlMs;
      const due = db
        .select({ id: transfers.id, createdAt: transfers.createdAt })
        .from(transfers)
        .where(
          or(
            and(eq(transfers.status, 'ready'), lte(transfers.expiresAt, new Date(t))),
            and(eq(transfers.status, 'uploading'), lte(transfers.createdAt, abandonedBefore)),
          ),
        )
        .all()
        .filter(({ id, createdAt }) => {
          const state = uploads.get(id);
          if (!state) return true;
          if (state.completing) return false; // finalising; the row turns ready (or completing resets) shortly
          if (createdAt.getTime() <= tooOld) return true;
          // a long upload that is still sending chunks is not abandoned
          return state.inflight === 0 && state.lastActivity <= abandonedBefore.getTime();
        });
      for (const { id } of due) await remove(id);
      db.delete(sessions).where(lte(sessions.expiresAt, new Date(t))).run();
      return due.length;
    },
  };
}
