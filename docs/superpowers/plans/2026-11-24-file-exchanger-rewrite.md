# File Exchanger Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the old Express/MySQL/jQuery app with a TypeScript + SQLite (Drizzle) service for chunked store-and-forward transfers, WebRTC direct transfers and accounts, with one mobile-friendly web page.

**Architecture:** One Node process serves a JSON API (Express 5), a WebSocket signaling endpoint (`ws`) and a static no-build frontend. State lives in one SQLite file plus a files directory under `DATA_DIR`. Services are plain modules created with injected deps (`db`, `config`, `mailer`, clock) so tests run in-process against a temp `DATA_DIR`.

**Tech Stack:** TypeScript run by `tsx` (no build), Express 5, `ws` 8, `zod` 4, `drizzle-orm` 0.45 + `better-sqlite3` + `drizzle-kit`, `express-session`, `express-rate-limit` 8, `nodemailer`, `archiver` (zip), `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-24-file-exchanger-rewrite-design.md`

## Global Constraints

- Branch `rewrite`. No backward compatibility: delete old code, formats and pages freely.
- Never describe the project as an alternative to or comparison with another product (README, page copy, comments).
- No CDN scripts/styles, no trackers, no analytics. Everything served from `public/`.
- Node 22, ESM (`"type": "module"`), TypeScript `strict`, imports with explicit `.ts` extension; run with `tsx`, type-check with `tsc --noEmit` (`noEmit`, `allowImportingTsExtensions`, `verbatimModuleSyntax`, `moduleResolution: "bundler"`).
- Keys: alphabet `23456789ABCDEFGHJKMNPQRSTUVWXYZ`, length `KEY_LENGTH` (default 6), case-insensitive input.
- Defaults: `TRANSFER_TTL_HOURS=24`, `LIVE_KEY_TTL_MINUTES=10`, `MAX_FILE_MB=2000`, `MAX_FILES_PER_TRANSFER=20`, `MAX_TRANSFER_MB=4000`, `CHUNK_MB=50`, `UPLOAD_ABANDON_MINUTES=60`, grant lifetime 15 min, direct connect timeout 15 s after receiver joins.
- Passwords (account and transfer) hashed as `scrypt$<saltHex>$<hashHex>`; transfer password never stored.
- API errors are JSON `{ "error": { "code": string, "message": string } }`.
- Commit messages: single line, lowercase prefix `add:` / `update:` / `fix:` / `delete:` / `docs:`, no trailers.
- Every task ends with `npm test` green (it runs `tsc --noEmit` then `node --import tsx --test 'test/**/*.test.ts'`).

## Review Focus

- Zero-byte files: a file with `size: 0` has zero chunks; `complete` must accept it and download returns an empty body (test in Task 5).
- Keys typed loosely (`k7px3m`, ` K7PX3M `, `K7P-X3M`): normalized to the canonical key; keys containing excluded look-alikes (`0`, `1`, `O`, `I`, `L`) are rejected, never silently mapped to another key (test in Task 3).
- Two uploads racing for the last storage: reservations happen at `create`, so the second create gets 507 even before any bytes arrive (test in Task 5).
- Non-ASCII and hostile original names (`тест.txt`, `a"b.txt`, `../x`) come back in `Content-Disposition` correctly encoded and never touch the disk path (test in Task 6).
- A receiver joining a key over WebSocket that belongs to a stored transfer (not live) gets `{ type: "not-live" }` and the page switches to normal receive (test in Task 8).

---

## File Structure

```
package.json, tsconfig.json, drizzle.config.ts, .env.example, Dockerfile, docker-compose.yml, README.md, CLAUDE.md
src/server.ts                 entry: wire everything, listen, start cleanup timer
src/app.ts                    createApp(deps) -> express app
src/config.ts                 loadConfig(env) -> Config (zod)
src/errors.ts                 HttpError, error middleware
src/db/schema.ts              drizzle tables
src/db/client.ts              openDb(dataDir) -> Db (runs migrations)
src/db/sessionStore.ts        DrizzleSessionStore (express-session Store)
src/lib/keys.ts               generateKey, normalizeKey, KEY_ALPHABET
src/lib/crypto.ts             hashPassword, verifyPassword, deriveFileKey, encryptFile, decryptStream, sealGrant, openGrant, randomToken, sha256Hex
src/lib/fileName.ts           safeDisplayName
src/services/mailer.ts        createMailer(config)
src/services/users.ts         createUserService(deps)
src/services/transfers.ts     createTransferService(deps)
src/realtime/signaling.ts     createSignaling(deps)
src/routes/auth.ts, src/routes/transfers.ts, src/routes/me.ts, src/routes/config.ts
src/middleware/rateLimits.ts, src/middleware/auth.ts
drizzle/                      generated SQL migrations
public/index.html, public/styles.css, public/js/{main,api,send,upload,receive,direct,account,qr,ui}.js, public/vendor/qrcode.min.js
test/helpers.ts               makeTestApp(), fake mailer, temp dirs, fake clock
test/*.test.ts
```

Delete: `server.js`, `src/*.js`, `src/routes/*.js`, `views/`, `public/css`, `public/img`, `public/js/background.js`, `public/js/script.js`, `schema.sql`, `migrations/`, `test/*.js`, `docs/superpowers/specs` stays. Keep `public/js/qrcode.min.js` → move to `public/vendor/qrcode.min.js`.

---

### Task 1: Project scaffold and config

**Files:**
- Delete: everything listed under "Delete" above
- Create: `package.json` (rewrite), `tsconfig.json`, `src/config.ts`, `test/config.test.ts`, `.env.example`, `.gitignore` (add `data/`)

**Interfaces:**
- Produces: `loadConfig(env: Record<string, string | undefined>): Config` where
  ```ts
  type Config = {
    port: number; dataDir: string; baseUrl: string; appSecret: Buffer; // 32 bytes
    trustProxy: boolean | number | string; cookieSecure: boolean;
    transferTtlMs: number; liveKeyTtlMs: number; keyLength: number;
    maxFileBytes: number; maxFilesPerTransfer: number; maxTransferBytes: number;
    storageCapBytes: number; chunkBytes: number; uploadAbandonMs: number;
    smtpUrl: string | null; mailFrom: string;
    iceServers: { urls: string | string[]; username?: string; credential?: string }[];
  }
  ```

- [ ] **Step 1:** Remove old code; `npm uninstall` old deps; install runtime deps `express@5 ws zod drizzle-orm better-sqlite3 express-session express-rate-limit@8 nodemailer archiver dotenv tsx` and dev deps `typescript drizzle-kit @types/node @types/express @types/ws @types/better-sqlite3 @types/express-session @types/nodemailer @types/archiver`. If `typescript@7` fails on any `@types` package, pin `typescript@5.9`. Scripts: `start: tsx src/server.ts`, `dev: tsx watch src/server.ts`, `test: tsc --noEmit && node --import tsx --test 'test/**/*.test.ts'`, `db:generate: drizzle-kit generate`. Remove `overrides`.
- [ ] **Step 2: Write failing tests** in `test/config.test.ts`:
  - defaults: `loadConfig({})` → `port 3000`, `keyLength 6`, `transferTtlMs 24*3600e3`, `chunkBytes 50*2**20`, `maxFileBytes 2000*2**20`, `maxTransferBytes 4000*2**20`, `maxFilesPerTransfer 20`, `liveKeyTtlMs 600e3`, `uploadAbandonMs 3600e3`, `smtpUrl null`, `iceServers` = `[{ urls: 'stun:stun.l.google.com:19302' }]`, `appSecret.length === 32`.
  - `TRUST_PROXY`: `''`/`'false'`/`'0'` → `false`; `'true'` → `1`; `'2'` → `2`; `'loopback'` → `'loopback'`.
  - `TURN_URL=turn:x:3478`, `TURN_USERNAME=u`, `TURN_CREDENTIAL=p` → iceServers has a second entry `{ urls: 'turn:x:3478', username: 'u', credential: 'p' }`.
  - `APP_SECRET` given as 64 hex chars → that buffer; invalid value (`'short'`) → throws.
  - `KEY_LENGTH=3` → throws (min 5, max 12); `CHUNK_MB=200` → throws (max 95, must stay under the proxy limit).
- [ ] **Step 3:** Run `npm test` → config tests fail (module missing).
- [ ] **Step 4:** Implement `src/config.ts` with a zod schema over env strings. Missing `APP_SECRET` → random 32 bytes and a `console.warn` (grants/sessions reset on restart). `DATA_DIR` default `./data`, resolved absolute. `STORAGE_CAP_GB` default 50. `MAIL_FROM` default `File Exchanger <no-reply@localhost>`.
- [ ] **Step 5:** `.env.example` lists every variable above with its default and a one-line comment.
- [ ] **Step 6:** `npm test` → PASS.
- [ ] **Step 7:** Commit `update: start typescript rewrite with config module`.

### Task 2: Database schema, client, session store

**Files:**
- Create: `src/db/schema.ts`, `src/db/client.ts`, `src/db/sessionStore.ts`, `drizzle.config.ts`, `drizzle/*` (generated), `test/db.test.ts`

**Interfaces:**
- Produces:
  - Tables (drizzle `sqliteTable`), timestamps as `integer` ms (`mode: 'timestamp_ms'`):
    - `users`: `id` int pk autoinc, `email` text unique not null, `name` text not null, `passwordHash` text not null, `confirmedAt` ts null, `createdAt` ts not null.
    - `emailTokens`: `tokenHash` text pk, `userId` int fk→users cascade, `expiresAt` ts.
    - `transfers`: `id` text pk (uuid), `key` text unique null, `ownerId` int fk→users set null, `passwordHash` text null, `encSalt` text null (hex), `uploadTokenHash` text not null, `status` text `'uploading'|'ready'` not null, `totalSize` int not null, `createdAt` ts, `expiresAt` ts.
    - `transferFiles`: `id` text pk (uuid), `transferId` text fk→transfers cascade, `originalName` text, `storedName` text, `size` int, `mime` text, `position` int.
    - `sessions`: `sid` text pk, `data` text, `expiresAt` ts.
  - `openDb(dataDir: string): { db: Db; close(): void }` — creates `dataDir`, opens `app.db` with `journal_mode=WAL`, `foreign_keys=ON`, runs `migrate(db, { migrationsFolder: <repo>/drizzle })`. `type Db = BetterSQLite3Database<typeof schema>`.
  - `class DrizzleSessionStore extends session.Store` with `get/set/destroy/touch`, constructor `(db: Db, now: () => number = Date.now)`; `set` takes expiry from `session.cookie.expires`, default 1 h.
- [ ] **Step 1: Write failing tests** `test/db.test.ts`: `openDb(tmp)` creates `app.db` and all five tables exist (`select name from sqlite_master`); reopening is idempotent; deleting a transfer cascades its `transferFiles`; session store `set` then `get` round-trips, `get` of an expired session returns `null` (fake `now`), `destroy` removes.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement schema/client/store; `drizzle.config.ts` (`dialect: 'sqlite'`, schema `./src/db/schema.ts`, out `./drizzle`); run `npm run db:generate` to create the initial migration and commit the generated files.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Commit `add: sqlite schema with drizzle and session store`.

### Task 3: Keys, crypto, file names

**Files:**
- Create: `src/lib/keys.ts`, `src/lib/crypto.ts`, `src/lib/fileName.ts`, `test/keys.test.ts`, `test/crypto.test.ts`, `test/fileName.test.ts`

**Interfaces:**
- Produces:
  - `KEY_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'`
  - `generateKey(length: number, isTaken: (key: string) => boolean): string` — `crypto.randomInt` per char; throws `Error('key space exhausted')` after 50 collisions.
  - `normalizeKey(input: unknown, length: number): string | null` — strip whitespace and `-`, uppercase, all chars in alphabet and exact length, else `null`.
  - `hashPassword(pw: string): Promise<string>`, `verifyPassword(pw: string, stored: string): Promise<boolean>` (timing-safe).
  - `deriveFileKey(password: string, saltHex: string): Promise<Buffer>` (scrypt, 32 bytes); `newSaltHex(): string` (16 bytes).
  - `encryptFile(src: string, dest: string, key: Buffer): Promise<void>` — format `iv(12) | AES-256-GCM ciphertext | tag(16)`, streaming.
  - `decryptStream(path: string, key: Buffer): Promise<Readable>` — errors (wrong key/tamper) surface as a stream error; uses `pipeline` so destroying the returned stream closes the file.
  - `sealGrant(p: { transferId: string; fileKey: Buffer; exp: number }, secret: Buffer): string` (base64url, AES-256-GCM, random iv), `openGrant(token: string, secret: Buffer, now: number): { transferId: string; fileKey: Buffer } | null` (null if malformed, tampered or `exp <= now`).
  - `randomToken(): string` (32 bytes base64url), `sha256Hex(s: string): string`.
  - `safeDisplayName(name: unknown): string` — basename only, control chars and `<>:"/\|?*` → `_`, strip leading dots, max 200 chars, empty → `'file'`.
- [ ] **Step 1: Write failing tests:**
  - keys: 1000 generated keys all match `/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/`; `isTaken` always true → throws; `normalizeKey('k7px3m',6) === 'K7PX3M'`, `normalizeKey(' K7P-X3M ',6) === 'K7PX3M'`, `normalizeKey('K0PX3M',6) === null`, `normalizeKey('KIPX3M',6) === null`, `normalizeKey('KLPX3M',6) === null`, `normalizeKey('K7PX3',6) === null`, `normalizeKey(['K7PX3M'],6) === null`.
  - crypto: hash/verify true/false and salted (two hashes differ); 3 MB random file encrypt→decrypt equal; wrong key and one flipped byte both reject when reading; destroying the decrypt stream after the first chunk leaves `/proc/self/fd` count unchanged; grant round-trip, expired → null, one char changed → null, other secret → null.
  - fileName: `'../../etc/passwd'→'passwd'`, `'..\\..\\win.ini'→'win.ini'`, `'.hidden'→'hidden'`, `'a<b>:c?.txt'→'a_b__c_.txt'`, `'тест.txt'` unchanged, `''→'file'`, `'..'→'file'`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement the three modules.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Commit `add: key, crypto and file name helpers`.

### Task 4: App skeleton, accounts and mail

**Files:**
- Create: `src/errors.ts`, `src/app.ts`, `src/middleware/rateLimits.ts`, `src/middleware/auth.ts`, `src/services/mailer.ts`, `src/services/users.ts`, `src/routes/auth.ts`, `src/routes/config.ts`, `test/helpers.ts`, `test/auth.test.ts`

**Interfaces:**
- Consumes: `Config`, `openDb`, `DrizzleSessionStore`, `hashPassword/verifyPassword/randomToken/sha256Hex`.
- Produces:
  - `class HttpError extends Error { constructor(status: number, code: string, message: string) }`; `errorMiddleware` maps `HttpError` and zod errors (`400 invalid_request`) to the JSON error shape, everything else to `500 internal`.
  - `type Mailer = { send(msg: { to: string; subject: string; text: string }): Promise<void> }`; `createMailer(config)`: nodemailer from `smtpUrl`, or console logger when `null`.
  - `type Deps = { config: Config; db: Db; mailer: Mailer; now: () => number; transfers?: TransferService; signaling?: Signaling }`.
  - `createApp(deps: Deps): express.Express` — sets `trust proxy` from config, JSON body parser (1 MB), session (`name: 'fx_sid'`, `secret: appSecret.toString('hex')`, store `DrizzleSessionStore`, `httpOnly`, `sameSite: 'lax'`, `secure: cookieSecure`, `maxAge` 7 days, `saveUninitialized: false`), mounts routers under `/api`, static `public/`, `GET /:key` (any path matching `^[A-Za-z0-9-]{4,16}$`) → `public/index.html`, error middleware last.
  - `createRateLimits(overrides?: Partial<Record<'auth'|'lookup'|'upload'|'ws', number>>)` → limiters: auth 20/15 min, lookup (metadata/unlock) 60/min, upload (create) 30/h, ws key allocation 30/h. Tests pass large overrides via `deps.config`-independent `makeTestApp({ rateLimits })`.
  - `requireUser` middleware → `401 auth_required`; `req.session.userId: number | undefined` (module augmentation).
  - `createUserService({ db, mailer, config, now })`: `signup({ name, email, password }, baseUrl)`, `confirm(token): Promise<number>` (returns userId, throws `HttpError(404,'invalid_token')`), `login(email, password): Promise<User>` (throws `401 invalid_credentials`; unconfirmed → `403 email_unconfirmed`), `get(id)`.
  - Routes: `POST /api/auth/signup` `{name (1-100), email, password (≥8)}` → `202 { ok: true }`; existing confirmed email → `202` as well (no account enumeration) and sends nothing; existing unconfirmed → re-sends link. `GET /confirm/:token` → confirms, regenerates session with userId, redirects to `/`; invalid → `404` page text. `POST /api/auth/login` `{email,password}` → `200 { user: { id, name, email } }`, session regenerated. `POST /api/auth/logout` → `204`. `GET /api/me` → `{ user }` or `{ user: null }`. Confirmation link: `${baseUrl || req.protocol+'://'+req.host}/confirm/<token>`, token valid 24 h, stored as `sha256Hex`.
  - `GET /api/config` → `{ keyLength, chunkBytes, maxFileBytes, maxFilesPerTransfer, maxTransferBytes, transferTtlMs, iceServers }`.
  - `test/helpers.ts`: `makeTestApp(opts?: { now?: () => number; configEnv?: Record<string,string>; rateLimits?: ... }) => Promise<{ base: string; mail: Msg[]; deps: Deps; close(): Promise<void> }>` — temp `DATA_DIR`, fake mailer, listens on port 0 (HTTP server also used for ws in Task 8); `cookieJar()` helper for fetch.
- [ ] **Step 1: Write failing tests** `test/auth.test.ts`: signup → 202 and one mail with `/confirm/<43-char token>`; login before confirm → 403 `email_unconfirmed`; confirm → 302 to `/` with session cookie; `GET /api/me` with that cookie → user; second use of token → 404; login wrong password → 401 `invalid_credentials`; signup again with same (confirmed) email → 202 and no new mail; logout → `me` returns `user: null`; short password → 400 `invalid_request`; request with no body → 400 not 500; `GET /api/config` returns `keyLength 6`; `GET /K7PX3M` returns the HTML page.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Create a placeholder `public/index.html` (`<!doctype html><title>File Exchanger</title>`); Task 9 replaces it.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Commit `add: express app skeleton and accounts`.

### Task 5: Chunked uploads and expiry

**Files:**
- Create: `src/services/transfers.ts`, `src/routes/transfers.ts`, `test/upload.test.ts`
- Modify: `src/app.ts` (mount router, accept `deps.transfers`)

**Interfaces:**
- Consumes: `generateKey`, `randomToken`, `sha256Hex`, `hashPassword`, `newSaltHex`, `deriveFileKey`, `encryptFile`, `safeDisplayName`, `HttpError`.
- Produces `createTransferService({ db, config, now }): TransferService`:
  - `create(input: { files: { name: string; size: number; mime?: string }[]; password?: string; ownerId?: number }): Promise<{ transferId: string; uploadToken: string; chunkBytes: number; files: { fileId: string; name: string; size: number }[] }>` — validates count `1..maxFilesPerTransfer`, each `size` integer `0..maxFileBytes`, total `≤ maxTransferBytes`; `password` without `ownerId` → `401 auth_required`; storage: `sum(totalSize of all transfers) + total > storageCapBytes` → `507 storage_full`. Creates `DATA_DIR/files/<transferId>/`; stored names are `<fileId>` (`.part` while uploading). Inserts transfer (`status 'uploading'`, `expiresAt = now + transferTtlMs`) and files in one transaction. Password → `passwordHash` + `encSalt` stored now; the plaintext password is kept only in an in-memory `Map<transferId, string>` until `complete` (lost on restart → that upload can't complete, acceptable).
  - `writeChunk(transferId, fileId, index: number, uploadToken: string, body: Readable): Promise<void>` — token must match `uploadTokenHash` (`403 bad_token`), status `uploading` (`409 not_uploading`), `index` in `0..ceil(size/chunkBytes)-1` (`400 bad_chunk`); writes at offset `index*chunkBytes` with `fs.createWriteStream(path, { flags: 'r+'|'w', start })`; more bytes than `min(chunkBytes, size - offset)` → abort, `413 chunk_too_large`; fewer → `400 short_chunk`. Re-sending a chunk overwrites.
  - `complete(transferId, uploadToken, opts?: { liveKey?: string; liveToken?: string }): Promise<ReadyTransfer>` — every file's `.part` exists with exact size (zero-byte files: create empty file at `create`), else `409 incomplete`; encrypt each `.part` → `<fileId>` if protected (then delete `.part`), else rename; key = `opts.liveKey` if `signaling.claimLiveKey(liveKey, liveToken, transferKeyHook)` accepts it (Task 8 wires this; until then ignore opts), otherwise `generateKey(config.keyLength, isTaken)` where `isTaken` checks ready transfers and `signaling?.isLive`; sets `status 'ready'`, `key`. Returns `ReadyTransfer = { key: string; url: string; expiresAt: number; protected: boolean; files: { fileId: string; name: string; size: number }[] }` (`url` = `${baseUrl}/${key}`; routes fill baseUrl from request when config empty).
  - `findReady(key: string): Promise<TransferRecord | null>` — via `normalizeKey`; expired → `null`.
  - `remove(transferId): Promise<void>` — deletes folder + row.
  - `cleanup(): Promise<number>` — removes ready transfers past `expiresAt` and uploading transfers older than `uploadAbandonMs`; returns count.
- Routes (upload limiter on create):
  - `POST /api/transfers` JSON → `201` create result (ownerId from session).
  - `PUT /api/transfers/:transferId/files/:fileId/chunks/:index` raw body, header `X-Upload-Token` → `204`. Mounted before `express.json`, no body parser.
  - `POST /api/transfers/:transferId/complete` header `X-Upload-Token`, JSON `{ liveKey?, liveToken? }` → `200 ReadyTransfer`.
- [ ] **Step 1: Write failing tests** `test/upload.test.ts` (configEnv `CHUNK_MB=1`, small caps where needed):
  - 2.5 MB file in 3 chunks + a 10-byte file → complete → `key` matches 6-char alphabet regex, `files` has both with sizes.
  - resending chunk 1 with the same bytes still completes; data on disk equals source (sha256).
  - zero-byte file alone: create, no chunks, complete → 200, size 0.
  - chunk 2 of a 2.5 MB file sent with 1 MB → 413 `chunk_too_large`; chunk index 3 → 400 `bad_chunk`; wrong token → 403.
  - complete with a missing chunk → 409 `incomplete`.
  - `MAX_FILES_PER_TRANSFER=2` with 3 files → 400; file over `MAX_FILE_MB` → 400; password while logged out → 401.
  - `STORAGE_CAP_GB` tiny (env set via helper so cap = 3 MB): create 2 MB transfer, second create 2 MB → 507 `storage_full`, before any chunk is sent.
  - fake clock: complete transfer, advance `now` past 24 h, `cleanup()` → 1, folder gone, row gone; an uploading transfer older than 60 min → removed; a fresh one stays.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement service and routes. `STORAGE_CAP_GB` accepts decimals (`0.003`) so the test can set 3 MB.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Commit `add: chunked uploads with limits and expiry`.

### Task 6: Receiving, protected downloads, owner management

**Files:**
- Create: `src/routes/me.ts`, `test/download.test.ts`
- Modify: `src/services/transfers.ts`, `src/routes/transfers.ts`

**Interfaces:**
- Consumes: `TransferService` from Task 5, `sealGrant/openGrant/deriveFileKey/verifyPassword/decryptStream`.
- Produces (service additions):
  - `unlock(key, password): Promise<string>` → grant (`exp = now + 15 min`); wrong password → `401 wrong_password`.
  - `openFile(record, fileId, grant?: string): Promise<{ name: string; size: number; mime: string; stream: Readable }>` — protected without valid grant for this transfer → `401 password_required`.
  - `listForOwner(ownerId): Promise<ReadyTransfer[]>`; `removeOwned(key, ownerId)` → `404 not_found` unless owner.
- Routes (lookup limiter on metadata + unlock):
  - `GET /api/transfers/:key` → `{ key, expiresAt, protected, files }`; protected without `?grant=` → `files: null`; unknown/expired/malformed → `404 not_found`.
  - `POST /api/transfers/:key/unlock` `{ password }` → `{ grant, files }`.
  - `GET /api/transfers/:key/files/:fileId[?grant=]` → body with `res.attachment(name)` and `Content-Length` for unprotected files; streamed with `pipeline` (client abort closes file).
  - `GET /api/transfers/:key/zip[?grant=]` → `application/zip`, `Content-Disposition: attachment; filename="<key>.zip"`, entries named by display name (duplicate names get ` (2)` suffix), `archiver('zip', { store: true })`.
  - `DELETE /api/transfers/:key` → owner only → `204`.
  - `GET /api/me/transfers` (requireUser) → `{ transfers: ReadyTransfer[] }`.
- [ ] **Step 1: Write failing tests** `test/download.test.ts`:
  - plain transfer: metadata lists files; download returns identical bytes; key in lowercase works; `/zip` response starts with bytes `PK\x03\x04` and its body contains both file names (stored, uncompressed entries).
  - protected (logged-in sender, password `pw123456`): metadata `protected: true, files: null`; file download without grant → 401; unlock wrong → 401 `wrong_password`; unlock right → grant + files; download with grant → original bytes; grant from another transfer → 401; fake clock +16 min → 401; receiver uses no cookie throughout.
  - names: uploads `тест.txt`, `a"b.txt`, `../x` → `Content-Disposition` contains `filename*=UTF-8''%D1%82%D0%B5%D1%81%D1%82.txt`, and `x`; nothing written outside `DATA_DIR/files/<id>/`.
  - owner: `/api/me/transfers` lists own transfer only; delete by another user → 404; by owner → 204 and metadata → 404.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Commit `add: downloads, protected unlock and owner transfers`.

### Task 7: Server entry

**Files:**
- Create: `src/server.ts`, `test/server.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `startServer(env = process.env): Promise<{ url: string; close(): Promise<void> }>` (exported for the test; module also self-starts when run directly via `import.meta.url === pathToFileURL(process.argv[1]).href`). Loads `.env` with `dotenv` (quiet), opens db, creates services, `http.createServer(app)`, runs `cleanup()` at start and every 60 s (`unref`), logs `Listening on <url>`.
- [ ] **Step 1: Write failing test** `test/server.test.ts`: `startServer({ PORT: '0', DATA_DIR: tmp })` → `GET /api/config` 200; `close()` resolves and port is closed.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** `npm test` → PASS; `DATA_DIR=$(mktemp -d) PORT=3477 npm start` logs `Listening on http://localhost:3477` (Ctrl-C).
- [ ] **Step 5:** Commit `add: server entry point`.

### Task 8: Direct transfer signaling

**Files:**
- Create: `src/realtime/signaling.ts`, `test/signaling.test.ts`
- Modify: `src/server.ts` (attach to the HTTP server), `src/services/transfers.ts` (`complete` uses `signaling.claimLiveKey`), `test/helpers.ts` (attach signaling)

**Interfaces:**
- Produces `createSignaling({ config, now, isStoredKey: (key: string) => boolean, rateLimitPerHour?: number }): Signaling`:
  - `attach(server: http.Server): void` — `WebSocketServer({ noServer: true })` on upgrade for path `/ws`; max message 64 KB.
  - `isLive(key): boolean`
  - `claimLiveKey(key, liveToken): boolean` — true if key is live and the token is the sender's; marks it bound.
  - `notifyStored(key): void` — sends `{ type: 'switch-to-download', key }` to the paired receiver, then closes both sockets and frees the key.
  - `close(): void`.
- Protocol (JSON text frames):
  - sender → `{ type: 'host' }` → server `{ type: 'hosted', key, liveToken, expiresAt, iceServers }` (key from `generateKey` with `isTaken = isLive || isStoredKey`).
  - receiver → `{ type: 'join', key }` (normalized) → if live and free: receiver gets `{ type: 'joined', iceServers }`, sender gets `{ type: 'peer-joined' }`; if stored key → `{ type: 'not-live' }`; if already has a receiver → `{ type: 'busy' }`; else `{ type: 'not-found' }`.
  - either → `{ type: 'signal', data }` → relayed verbatim to the peer as `{ type: 'signal', data }`.
  - sender disconnect → receiver gets `{ type: 'peer-left' }`, key freed; receiver disconnect → sender gets `{ type: 'peer-left' }`, key stays live for a new receiver.
  - live key expires after `liveKeyTtlMs` unless bound → both get `{ type: 'expired' }`.
  - more than `rateLimitPerHour` (default 30) `host` messages from one IP → `{ type: 'error', code: 'rate_limited' }`.
- `complete()` with `{ liveKey, liveToken }` and `claimLiveKey` true → uses that key, then calls `notifyStored(key)` after commit.
- [ ] **Step 1: Write failing tests** `test/signaling.test.ts` (real `ws` clients against `makeTestApp`):
  - host → `hosted` with 6-char key; join (lowercase) → `joined` + sender `peer-joined`; `signal` relayed both ways with identical `data`.
  - third client join → `busy`; join unknown → `not-found`; join a stored transfer's key → `not-live`.
  - sender closes → receiver `peer-left`, then join same key → `not-found`.
  - fake clock past 10 min + tick → `expired`.
  - fallback: host, receiver joins, sender does chunked upload and `complete` with `{ liveKey, liveToken }` → response key equals live key, receiver gets `{ type: 'switch-to-download', key }`, `GET /api/transfers/<key>` → 200. Wrong `liveToken` → completes with a different, new key and receiver gets nothing.
  - 31st `host` from one client IP (set `rateLimitPerHour: 30`) → `rate_limited`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement; expiry checked by a 5 s interval (`unref`) plus on each message, using `now()`. **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Commit `add: websocket signaling for direct transfers`.

### Task 9: Web frontend

**Files:**
- Create: `public/index.html`, `public/styles.css`, `public/js/main.js`, `public/js/api.js`, `public/js/upload.js`, `public/js/send.js`, `public/js/receive.js`, `public/js/direct.js`, `public/js/account.js`, `public/js/qr.js`, `public/js/ui.js`, `test/frontend.test.ts`
- Move: `public/js/qrcode.min.js` → `public/vendor/qrcode.min.js`

**Interfaces:**
- Consumes: the HTTP API (Tasks 4–6) and WebSocket protocol (Task 8). `api.js` wraps `fetch` and throws `ApiError { status, code, message }` from the JSON error shape.
- Produces (pure, importable from Node for tests):
  - `upload.js`: `planChunks(size: number, chunkBytes: number): { index: number; start: number; end: number }[]` (empty for size 0); `uploadTransfer(files: File[], opts: { password?, liveKey?, liveToken?, onProgress(sent, total) }) → ReadyTransfer` — create → chunks sequentially per file, each chunk retried up to 3 times with 1 s/2 s/4 s backoff → complete.
  - `direct.js`: `encodeHeader(meta: { name, size, mime }) / decodeHeader(buf)`; `sendFiles(channel, files, onProgress)` with 64 KB chunks and `bufferedAmountLowThreshold = 1 MB` backpressure; `receiveFiles(channel, onFile, onProgress)`.
- Behaviour:
  - Views (one page, JS-switched): **Send** (drop zone + picker, file list with sizes, optional password field shown only when logged in, buttons "Upload" and "Send directly"), **Result** (big key, copy-link button, QR of the share URL, countdown to expiry), **Receive** (key input `maxlength` 7, file list, per-file download links and "Download all (.zip)", password prompt when protected), **Direct** (sender: key + "waiting for receiver"; both: progress; receiver: list of received files as blob download links), **Account** (login / signup forms, "My transfers" with delete).
  - URL `/<key>` opens Receive for that key: first tries `join` over WebSocket; `not-live` → normal receive; `joined` → direct receive.
  - Direct sender: after `peer-joined`, start WebRTC offer; if the data channel isn't open 15 s later, show "Couldn't connect directly. Upload instead?" → `uploadTransfer(files, { liveKey, liveToken })`; receiver handles `switch-to-download` by loading Receive for the key.
  - Copy: neutral, product named "File Exchanger"; no comparisons with other products.
  - Responsive from 320 px; light/dark via `prefers-color-scheme`; no external requests.
- [ ] **Step 1: Write failing tests** `test/frontend.test.ts`: `planChunks(0, 10)` → `[]`; `planChunks(25, 10)` → three chunks ending at 10, 20, 25; header encode/decode round-trips `тест.txt`; `public/index.html` contains no `http://` or `https://` URLs in `src`/`href`; no file under `public/` contains the string `send-anywhere` (case-insensitive).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** `npm test` → PASS.
- [ ] **Step 5: Manual check** with the gstack browser skill against `npm start` (temp `DATA_DIR`, console mailer): upload 2 files → key/QR shown; open `/<key>` in a second tab → download one file and the zip; signup → confirm link from console → login → protected upload → receive in a private window with password; "Send directly" in tab A, open link in tab B → files arrive; mobile viewport 375 px renders without horizontal scroll.
- [ ] **Step 6:** Commit `add: web frontend for sending, receiving and direct transfers`.

### Task 10: Docker, docs, cleanup

**Files:**
- Create/replace: `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `README.md`, `CLAUDE.md`, `.nvmrc` (22)

**Interfaces:** none new.

- Dockerfile: `node:22-alpine`, `npm ci --omit=dev` (keep `tsx` in dependencies), copy `src public drizzle package*.json`, `ENV DATA_DIR=/data`, `VOLUME /data`, non-root `node` user owning `/data`, `CMD ["npx","tsx","src/server.ts"]`, `EXPOSE 3000`.
- Compose: one `app` service, `env_file: .env` (optional), volume `data:/data`, port `${APP_PORT:-3000}:3000`. No database service.
- README: what it does (send with key/link/QR, direct transfer, accounts for protected files), quick start (compose), local dev (`npm install`, `cp .env.example .env`, `npm run dev`), configuration table (every env var with default), running behind a reverse proxy/tunnel (`TRUST_PROXY`, `COOKIE_SECURE`, `BASE_URL`; chunks stay under 100 MB), tests, project layout. Neutral wording; no product comparisons. Keep the license section.
- CLAUDE.md: stack, commands, architecture notes (key space shared by live and stored transfers, upload token vs key, grant tokens, chunk flow, signaling protocol summary, `npm run db:generate` after schema changes).

- [ ] **Step 1:** Write the files.
- [ ] **Step 2:** `docker compose -p fx-rewrite up -d --build` with `APP_PORT` set to a free port; `curl -s localhost:$APP_PORT/api/config` → JSON with `"keyLength":6`; upload a file via `curl` (create → chunk → complete) and download it; `docker compose -p fx-rewrite down -v`.
- [ ] **Step 3:** `npm test` → PASS; `grep -ri "send.anywhere" --exclude-dir=node_modules --exclude-dir=.git .` → only matches inside `docs/superpowers/` and `test/frontend.test.ts`.
- [ ] **Step 4:** Commit `docs: readme, claude.md and docker setup for the rewrite`.
