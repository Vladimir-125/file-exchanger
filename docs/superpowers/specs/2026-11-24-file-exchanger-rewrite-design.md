# File Exchanger rewrite — design

Date: 2026-11-24
Branch: `rewrite` (from `modernize`)

## Intent

File Exchanger is a self-hosted, ad-free service for moving files between devices.
Vladimir will run it on his own server for himself and for anyone he shares it with.
Anyone can send files without an account; registered users can additionally protect
files with a password. The codebase dates from a school project and should become
small, typed and easy to maintain. Nobody uses the old version, so **no backward
compatibility** is needed: old data, file formats, API responses and pages can go.

Public-facing text (README, page copy) describes it simply as a project. It must not
be described as an alternative to, or compared with, any other product.

## Goals

- Send one or more files, receive them with a short key, share link or QR code.
- Direct browser-to-browser transfer when both sides are online.
- Accounts (signup with email confirmation, login) to unlock password-protected transfers.
- Safe to expose publicly: abuse limits, unguessable keys, automatic expiry.
- Easy to run: one container, one data volume, SQLite.
- Code that is easy to change: TypeScript, clear modules, tests.

## Non-goals (this round)

- Desktop app (`file-exchanger-desktop` repo) — later; it will wrap the web page.
- Password reset, account deletion, admin/moderation tools.
- Browser-side end-to-end encryption.
- Resuming an upload after closing the page (chunks only retry within a session).

## Anti-goals

- Ads, trackers, third-party analytics, or CDN-loaded scripts.
- Requiring an account for basic send/receive.
- Anything that lets one visitor fill the disk or enumerate other people's files.

## Decisions (made with Vladimir)

| Topic | Decision |
| --- | --- |
| Expiry | Unchanged at 24 h, configurable via `TRANSFER_TTL_HOURS`. |
| Keys | 6 characters, letters + digits, case-insensitive, without look-alikes (alphabet `23456789ABCDEFGHJKMNPQRSTUVWXYZ`, 31 symbols ≈ 887 M keys). Length configurable (`KEY_LENGTH`). |
| Accounts | Kept: signup + email confirmation + login. Password protection requires login. |
| Direct transfer | Implemented: WebRTC data channel, signaling over WebSocket on the same server. |
| Database | SQLite via Drizzle ORM (`better-sqlite3` driver, `drizzle-kit` migrations). |
| Language | TypeScript, run directly by Node 22 (type stripping); `tsc --noEmit` for checks. |
| Desktop | Out of scope this round. |
| Large uploads | Chunked (~50 MB pieces) so uploads pass Cloudflare's 100 MB per-request limit (server will sit behind cloudflared). |
| Protected receive | Only the sender needs an account; receivers need key + password, no login. |

## Approaches considered

1. **One web app served by the backend; desktop later wraps it** — chosen. One UI to
   maintain; JSON API + WebSocket; no build step.
2. Separate UIs per client over a shared API — rejected: every feature (especially
   WebRTC) written twice across two repos.
3. Framework frontend (React + Vite) — rejected: build pipeline and dependency weight
   out of proportion to a one-screen app.

ORM options: Drizzle (chosen: SQL-like, no codegen, light), Prisma (heavier, codegen
step), Sequelize (dated).

## Design

### Runtime and layout

- Node ≥ 22.18 runs `.ts` directly. TypeScript limited to erasable syntax
  (`erasableSyntaxOnly`): no enums, namespaces or parameter properties. Imports use
  explicit `.ts` extensions (`allowImportingTsExtensions`, `verbatimModuleSyntax`).
- ESM (`"type": "module"`).
- Express 5 for HTTP, `ws` for WebSocket, `zod` for request validation.

```
src/
  server.ts            entry: config, db, migrations, http + ws server, cleanup timer
  app.ts               express app factory (deps injected for tests)
  config.ts            env parsing (zod), typed config object
  db/schema.ts         drizzle tables
  db/client.ts         better-sqlite3 + drizzle, runs migrations on start
  services/            transfers, storage (disk + encryption), keys, users, mail
  routes/              api/transfers.ts, api/auth.ts, api/me.ts
  realtime/signaling.ts  WebSocket rooms for direct transfer
  middleware/          auth, rate limits, errors
public/                index.html, app.js (+ modules), styles.css, vendored qrcode lib
drizzle/               generated migrations
test/
```

### Data model (SQLite)

- `users`: id, email (unique, lowercase), name, password_hash (scrypt), confirmed_at
  (null until confirmed), created_at.
- `email_tokens`: token (hash of a random 32-byte value), user_id, expires_at.
  Unconfirmed users cannot log in. Re-signup with an unconfirmed email re-sends the
  link instead of failing.
- `transfers`: id, key (unique), owner_id (nullable), password_hash (nullable),
  created_at, expires_at, total_size, status (`uploading` | `ready`).
- `transfer_files`: id, transfer_id, original_name, stored_name, size, mime.
- `sessions`: sid, data, expires_at (express-session store backed by Drizzle/SQLite).

Storage on disk: `DATA_DIR/files/<transfer id>/<stored_name>`; DB at `DATA_DIR/app.db`.
Stored names are generated (not user-supplied); original names are kept in the DB only.

### Transfers (store and forward)

Uploads are chunked so no single request exceeds Cloudflare's 100 MB limit:

1. `POST /api/transfers` JSON `{ files: [{ name, size, mime }], password? }`
   (password only when logged in) → `{ transferId, uploadToken, chunkSize, files: [{ fileId }] }`.
   Limits (file count, sizes, storage cap) are checked here against declared sizes.
   No key is assigned yet; the transfer has `status = uploading`.
2. `PUT /api/transfers/:transferId/files/:fileId/chunks/:index` raw body
   (`application/octet-stream`, ≤ `CHUNK_MB`, default 50), header
   `X-Upload-Token`. Chunks stream straight to `<fileId>.part` at offset
   `index * chunkSize`; re-sending a chunk overwrites it (client retries a failed
   chunk up to 3 times). Server rejects bytes beyond the declared size.
3. `POST /api/transfers/:transferId/complete` → server checks every file reached its
   declared size, encrypts protected files (streaming `.part` → encrypted file), sets
   `status = ready`, assigns the key → `{ key, url, expiresAt, files }`.
- Uploads that never complete are deleted by the cleanup timer after
  `UPLOAD_ABANDON_MINUTES` (default 60); their reserved size counts toward the
  storage cap while pending.
- The upload token is random, stored hashed on the transfer, and only lets the creator
  add chunks / complete; it is not the download key.
- A transfer is only findable once `status = ready`.
- `GET /api/transfers/:key` → metadata `{ files, expiresAt, protected }`. For protected
  transfers the file list is returned only after the password is verified.
- `POST /api/transfers/:key/unlock` `{ password }` → returns a download grant: a token
  sealed with AES-GCM under a server secret (`APP_SECRET`) containing the transfer id,
  the derived file key and an expiry (15 min). Downloads pass it as `?grant=`
  (so plain links/`<a download>` work). Stateless, survives restarts. Receivers do not
  need to be logged in.
- `GET /api/transfers/:key/files/:fileId` → download one file.
- `GET /api/transfers/:key/zip` → all files as a zip stream (`archiver`).
- `DELETE /api/transfers/:key` → owner only.
- Share link `/<key>` (e.g. `https://host/K7PX3M`) opens the page in receive mode; QR
  encodes this link.
- Protected files: AES-256-GCM per file, key from scrypt(password, per-transfer salt).
  Password hash stored with scrypt; the password itself is never stored.
- Expiry: a timer deletes expired transfers (rows + folders) every minute, and lookups
  treat expired transfers as missing.

### Direct transfer (WebRTC)

- Sender opens "Send directly", selects files; server allocates a key from the same key
  space (marked as live, never stored on disk) via WebSocket `/ws`.
- Receiver enters the key (or opens the link); server pairs the two sockets and relays
  SDP offers/answers and ICE candidates only. One receiver per live key.
- Files go over an `RTCDataChannel` in chunks with backpressure
  (`bufferedAmountLowThreshold`), with a small header per file (name, size, mime).
  Receiver assembles to a Blob and offers download; progress shown on both sides.
- ICE servers from config: default public STUN (`stun:stun.l.google.com:19302`),
  optional TURN (`TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL`) passed to clients.
- The ~15 s connection timeout starts when a receiver joins (not when the key is
  issued; the sender can wait for a receiver up to the live-key TTL).
- On timeout the sender sees "Couldn't connect directly — upload instead?". Accepting
  uploads the same file selection via the chunked flow, and on `complete` the server
  binds the **same key** to the stored transfer and sends the waiting receiver a
  `switch-to-download` message, so their page moves to the normal receive view.
- Live keys expire when the sender disconnects or after `LIVE_KEY_TTL_MINUTES`
  (default 10).
- Direct transfers don't require login and don't support passwords (the data never
  touches the server).

### Accounts

- `POST /api/auth/signup` `{ name, email, password }` (min 8 chars) → sends
  confirmation email; `GET /confirm/:token` confirms and logs in.
- `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/me`.
- `GET /api/me/transfers` → the user's active transfers; delete via
  `DELETE /api/transfers/:key`.
- Sessions in SQLite; cookie `httpOnly`, `sameSite=lax`, `secure` configurable;
  session regenerated on login.
- Mail via SMTP (`SMTP_URL`, `MAIL_FROM`); if unset, the confirmation link is logged.

### Abuse limits (all configurable)

- `MAX_FILE_MB` (default 2000), `MAX_FILES_PER_TRANSFER` (20), `MAX_TRANSFER_MB` (4000),
  `STORAGE_CAP_GB` (total on disk; uploads rejected with 507 when exceeded).
- Rate limits per IP: uploads, key lookups/unlock attempts (to stop key guessing),
  auth endpoints, WebSocket key allocations.
- `TRUST_PROXY` parsed explicitly (false / hop count / list) for running behind
  cloudflared.

### Frontend

- Single page `public/index.html`, plain JS ES modules, no framework, no build, no
  CDN. Mobile first, responsive, light/dark via `prefers-color-scheme`.
- Views: Send (upload or direct), Receive (key input, file list, download all),
  Account (login/signup, my transfers). Hash-free routing: `/` and `/<key>`.
- Drag-and-drop and file picker, upload progress, copy-link button, QR code
  (vendored `qrcode` library), countdown to expiry.

### Ops

- Dockerfile (node:22-alpine, non-root), compose with one volume mounted at
  `DATA_DIR`. No database container.
- `.env.example` documents every setting. README rewritten for the new project.
- Migrations run automatically on start.

### Testing

- `node --test` with TypeScript files; `tsc --noEmit` as part of `npm test`.
- Unit: key generation/normalization, encryption round trip and tamper detection,
  config parsing, file name handling.
- Integration (in-process, temp `DATA_DIR`, fake mailer): chunked upload (multi-chunk,
  retry of a chunk, oversize rejection, incomplete upload rejected and cleaned up),
  upload/download single and multiple files, zip, protected transfers (login required, unlock, wrong password),
  expiry cleanup, storage cap, rate-limit behaviour, signup/confirm/login/me, owner
  delete.
- Signaling: two `ws` clients pair on a key, messages relay, third client rejected,
  sender disconnect frees the key, fallback binds the live key to the stored transfer
  and notifies the receiver. WebRTC itself is checked manually in two browsers.

## Left to the builder

- Exact module boundaries inside `services/`, naming, and helper structure.
- UI layout details and styling.
- Choice of zip library and QR library (small, maintained, vendored or npm).
- Exact rate-limit numbers and defaults not listed above.
- Signaling message format.

## Calls made by Claude (check these)

- Grant token is stateless (sealed with `APP_SECRET`) rather than an in-memory map.
- Raised size defaults to 2 GB per file / 4 GB per transfer now that uploads are chunked.
- Key is assigned on `complete`, not at upload start, so half-uploaded transfers never
  have a key.
- Upload token is separate from the download key.
- Server-side encryption happens after all chunks arrive (one streaming pass).
