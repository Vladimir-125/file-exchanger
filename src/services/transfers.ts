import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { and, asc, desc, eq, gt, inArray, lte, or, sql } from 'drizzle-orm';
import { ipKeyGenerator } from 'express-rate-limit';
import type { Config } from '../config.ts';
import type { Db } from '../db/client.ts';
import { sessions, transferFiles, transfers, type Transfer, type TransferFile } from '../db/schema.ts';
import { HttpError } from '../errors.ts';
import {
  deriveFileKey, encryptFile, hashPassword, newSaltHex, openGrant, randomToken, sealGrant, sha256Hex, verifyPassword,
} from '../lib/crypto.ts';
import { safeDisplayName } from '../lib/fileName.ts';
import { generateKey, normalizeKey } from '../lib/keys.ts';
import { openStored, uniqueNames, zipStream } from './downloads.ts';

/** Implemented by the WebRTC signaling hub (Task 8). */
export type Signaling = {
  isLive(key: string): boolean;
  claimLiveKey(key: string, liveToken: string): boolean;
  releaseClaim(key: string, liveToken: string): void;
  notifyStored(key: string): void;
};

export type CreateInput = {
  files: { name: string; size: number; mime?: string }[];
  password?: string;
  ownerId?: number;
  /** The creating client's IP (req.ip): its unfinished uploads may reserve at most `maxTransferBytes`. */
  ip?: string;
};
export type PublicFile = { fileId: string; name: string; size: number };
export type CreateResult = { transferId: string; uploadToken: string; chunkBytes: number; files: PublicFile[] };
export type ReadyTransfer = { key: string; url: string; expiresAt: number; protected: boolean; files: PublicFile[] };
export type TransferRecord = { transfer: Transfer; files: TransferFile[] };
export type TransferView = { key: string; expiresAt: number; protected: boolean; files: PublicFile[] | null };
export type OpenedFile = { name: string; size: number; mime: string; stream: Readable };
export type CompleteOpts = { liveKey?: string; liveToken?: string; baseUrl?: string };
export type TransferService = ReturnType<typeof createTransferService>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_MIME = 100;
const GRANT_MS = 15 * 60_000;

/** Per-upload state that only lives in memory: lost on restart, so such uploads cannot complete. */
type UploadState = {
  password?: string;
  received: Map<string, Set<number>>; // fileId -> chunk indexes fully written
  inflight: number;
  completing: boolean;
  lastActivity: number; // when a chunk was last written successfully
  client: string; // rate-limit key of the creator's IP (IPv6 by prefix)
  size: number; // bytes reserved against the storage cap
};

const notFound = () => new HttpError(404, 'not_found', 'Transfer not found');
const incomplete = () => new HttpError(409, 'incomplete', 'Not every file has been fully uploaded');
const notUploading = () => new HttpError(409, 'not_uploading', 'Transfer is not accepting uploads');
const passwordRequired = () => new HttpError(401, 'password_required', 'This transfer needs its password');
const uploadLost = () =>
  new HttpError(409, 'upload_lost', 'The server restarted during this upload; start a new transfer');

const publicFiles = (files: TransferFile[]): PublicFile[] =>
  files.map((f) => ({ fileId: f.id, name: f.originalName, size: f.size }));

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

  /** The upload's in-memory state; after a restart there is none and the upload is lost. */
  function stateOf(row: Transfer): UploadState {
    const state = uploads.get(row.id);
    if (!state) throw uploadLost();
    return state;
  }

  const urlOf = (key: string, baseUrl?: string) => `${baseUrl ?? config.baseUrl}/${key}`;
  const filePath = (file: TransferFile) => path.join(dirOf(file.transferId), file.storedName);

  function filesOf(transferId: string): TransferFile[] {
    return db
      .select()
      .from(transferFiles)
      .where(eq(transferFiles.transferId, transferId))
      .orderBy(asc(transferFiles.position))
      .all();
  }

  /**
   * The file key a grant opens for this transfer: null for an unprotected transfer, undefined when
   * the grant is missing, invalid, expired or issued for another transfer.
   */
  function grantedKey(record: TransferRecord, grant: string | undefined): Buffer | null | undefined {
    if (record.transfer.passwordHash === null) return null;
    if (!grant) return undefined;
    const opened = openGrant(grant, config.appSecret, now());
    return opened?.transferId === record.transfer.id ? opened.fileKey : undefined;
  }

  function requireKey(record: TransferRecord, grant: string | undefined): Buffer | null {
    const key = grantedKey(record, grant);
    if (key === undefined) throw passwordRequired();
    return key;
  }

  async function findReady(input: string): Promise<TransferRecord | null> {
    const key = normalizeKey(input, config.keyLength);
    if (!key) return null;
    const transfer = db
      .select()
      .from(transfers)
      .where(and(eq(transfers.key, key), eq(transfers.status, 'ready')))
      .get();
    if (!transfer || transfer.expiresAt.getTime() <= now()) return null;
    return { transfer, files: filesOf(transfer.id) };
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
      const client = ipKeyGenerator(input.ip ?? '');
      let reserved = 0;
      for (const u of uploads.values()) if (u.client === client) reserved += u.size;
      if (reserved + total > config.maxTransferBytes) {
        throw new HttpError(429, 'too_many_uploads', 'Finish or cancel your other uploads before starting a new one');
      }
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
      // registered before the awaits below, so a concurrent create from the same client sees it
      uploads.set(transferId, {
        password: input.password,
        received: new Map(fileRows.map((f) => [f.id, new Set<number>()])),
        inflight: 0,
        completing: false,
        lastActivity: t,
        client,
        size: total,
      });

      try {
        const dir = dirOf(transferId);
        await fs.mkdir(dir, { recursive: true });
        await Promise.all(fileRows.map((f) => fs.writeFile(path.join(dir, `${f.storedName}.part`), '')));
      } catch (err) {
        await remove(transferId).catch(() => {});
        throw err;
      }

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
      try {
        await pipeline(body, counter, out);
      } catch (err) {
        if (err instanceof HttpError) throw err;
        if (fsError) throw fsError;
        throw new HttpError(400, 'aborted', 'The upload was interrupted'); // client went away
      } finally {
        state.inflight--;
      }
      if (received < expected) throw new HttpError(400, 'short_chunk', `Chunk ${index} must be ${expected} bytes`);
      chunks.add(index);
      state.lastActivity = now(); // only a written chunk counts as progress: failing PUTs cannot keep a reservation
    },

    async complete(transferId: string, uploadToken: string, opts: CompleteOpts = {}): Promise<ReadyTransfer> {
      const row = uploadingTransfer(transferId, uploadToken);
      const state = stateOf(row);
      if (state.completing) throw notUploading();
      if (state.inflight > 0) throw incomplete();
      const files = filesOf(transferId);
      for (const f of files) {
        const got = state.received.get(f.id);
        for (let i = 0; i < chunkCount(f.size); i++) if (!got?.has(i)) throw incomplete();
      }

      // a fallback upload from a direct transfer keeps the live key the receiver is waiting on;
      // claiming it now also stops it expiring while the files are finalised
      const liveKey = opts.liveToken === undefined ? null : normalizeKey(opts.liveKey, config.keyLength);
      const claimLive = () => liveKey !== null && signaling?.claimLiveKey(liveKey, opts.liveToken!) === true;
      const claimed = claimLive();
      const release = () => {
        if (claimed) signaling!.releaseClaim(liveKey!, opts.liveToken!);
      };

      state.completing = true; // blocks new chunks and a second complete while files are finalised
      const dir = dirOf(transferId);
      let key: string;
      let expiresAt: number;
      let keptLive = false;
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
        const inDb = (k: string) =>
          db.select({ id: transfers.id }).from(transfers).where(eq(transfers.key, k)).get() !== undefined;
        const isTaken = (k: string) => signaling?.isLive(k) === true || inDb(k);
        // claimed again: the sender may have left during the awaits, freeing the key
        keptLive = claimLive() && !inDb(liveKey!);
        key = keptLive ? liveKey! : generateKey(config.keyLength, isTaken);
        expiresAt = now() + config.transferTtlMs; // the TTL counts from when the files become available
        db.update(transfers)
          .set({ status: 'ready', key, expiresAt: new Date(expiresAt) })
          .where(eq(transfers.id, transferId))
          .run();
      } catch (err) {
        state.completing = false; // otherwise cleanup would skip this transfer forever
        release(); // a failed upload must not keep the live key from expiring
        throw err;
      }
      uploads.delete(transferId);
      if (keptLive) signaling?.notifyStored(key);
      else release(); // the receiver switches to a normal download

      return {
        key,
        url: urlOf(key, opts.baseUrl),
        expiresAt,
        protected: row.passwordHash !== null,
        files: publicFiles(files),
      };
    },

    findReady,

    /** Whether a ready, unexpired transfer has this (normalized) key. */
    hasReadyKey(key: string): boolean {
      const row = db
        .select({ expiresAt: transfers.expiresAt })
        .from(transfers)
        .where(and(eq(transfers.key, key), eq(transfers.status, 'ready')))
        .get();
      return row !== undefined && row.expiresAt.getTime() > now();
    },

    /** Public metadata; a protected transfer lists its files only with a valid grant. */
    view(record: TransferRecord, grant?: string): TransferView {
      const { transfer, files } = record;
      return {
        key: transfer.key!,
        expiresAt: transfer.expiresAt.getTime(),
        protected: transfer.passwordHash !== null,
        files: grantedKey(record, grant) === undefined ? null : publicFiles(files),
      };
    },

    /** Checks the password, then issues a stateless grant carrying the file key (15 min). */
    async unlock(key: string, password: string): Promise<{ grant: string; files: PublicFile[] }> {
      const record = await findReady(key);
      if (!record) throw notFound();
      const { transfer } = record;
      if (transfer.passwordHash === null || transfer.encSalt === null) {
        throw new HttpError(400, 'not_protected', 'This transfer has no password');
      }
      // verify first: deriving the file key from a wrong password would only waste work
      if (!(await verifyPassword(password, transfer.passwordHash))) {
        throw new HttpError(401, 'wrong_password', 'Wrong password');
      }
      const fileKey = await deriveFileKey(password, transfer.encSalt);
      const grant = sealGrant({ transferId: transfer.id, fileKey, exp: now() + GRANT_MS }, config.appSecret);
      return { grant, files: publicFiles(record.files) };
    },

    /** A file's download metadata after the same checks openFile makes; opens nothing (HEAD). */
    fileInfo(record: TransferRecord, fileId: string, grant?: string): Omit<OpenedFile, 'stream'> {
      const file = record.files.find((f) => f.id === fileId);
      if (!file) throw notFound();
      requireKey(record, grant);
      return { name: file.originalName, size: file.size, mime: file.mime };
    },

    /** Throws unless the grant opens the transfer (always passes for an unprotected one). */
    checkAccess(record: TransferRecord, grant?: string): void {
      requireKey(record, grant);
    },

    /** Opens one file for download (decrypting a protected one); needs a grant when protected. */
    async openFile(record: TransferRecord, fileId: string, grant?: string): Promise<OpenedFile> {
      const file = record.files.find((f) => f.id === fileId);
      if (!file) throw notFound();
      const fileKey = requireKey(record, grant);
      const stream = await openStored(filePath(file), fileKey);
      return { name: file.originalName, size: file.size, mime: file.mime, stream };
    },

    /** A stored zip of every file under unique display names; needs a grant when protected. */
    openZip(record: TransferRecord, grant?: string): Readable {
      const fileKey = requireKey(record, grant);
      const names = uniqueNames(record.files.map((f) => f.originalName));
      return zipStream(record.files.map((f, i) => ({ name: names[i]!, open: () => openStored(filePath(f), fileKey) })));
    },

    /** The owner's ready, unexpired transfers, newest first. */
    async listForOwner(ownerId: number, baseUrl?: string): Promise<ReadyTransfer[]> {
      const rows = db
        .select()
        .from(transfers)
        .where(and(eq(transfers.ownerId, ownerId), eq(transfers.status, 'ready'), gt(transfers.expiresAt, new Date(now()))))
        .orderBy(desc(transfers.expiresAt), desc(transfers.createdAt))
        .all();
      if (rows.length === 0) return [];
      const allFiles = db
        .select()
        .from(transferFiles)
        .where(inArray(transferFiles.transferId, rows.map((r) => r.id)))
        .orderBy(asc(transferFiles.position))
        .all();
      return rows.map((t) => ({
        key: t.key!,
        url: urlOf(t.key!, baseUrl),
        expiresAt: t.expiresAt.getTime(),
        protected: t.passwordHash !== null,
        files: publicFiles(allFiles.filter((f) => f.transferId === t.id)),
      }));
    },

    /** Deletes a ready transfer; anyone but its owner gets 404 so keys of others are not confirmed. */
    async removeOwned(key: string, ownerId: number): Promise<void> {
      const record = await findReady(key);
      if (!record || record.transfer.ownerId !== ownerId) throw notFound();
      await remove(record.transfer.id);
    },

    /** Absolute path of a ready file on disk. */
    filePath,

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
