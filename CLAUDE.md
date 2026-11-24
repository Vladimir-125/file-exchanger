# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

File Exchanger: a self-hosted, ad-free file-sharing app. Send files with a short key, link or QR code, either direct (WebRTC) or stored on the server for a limited time. Optional password protection for signed-in users. No CDN scripts, trackers or analytics: everything is served from `public/`.

## Stack

Node 22, ESM, TypeScript `strict`, run with `tsx` (no build step; the local Node has no built-in TS support). Imports use explicit `.ts` extensions. Express 5, SQLite via `better-sqlite3` + Drizzle ORM, `ws`, `zod`, `express-rate-limit`, `archiver`, `nodemailer`. Plain HTML/JS frontend in `public/`.

## Commands

- `npm start`: run the server (`tsx src/server.ts`)
- `npm run dev`: same with `tsx watch`
- `npm test`: `tsc --noEmit`, then `node --import tsx --test 'test/**/*.test.ts'`. Must be green and output must stay clean.
- `npm run db:generate`: run after every change to `src/db/schema.ts`; commit the generated files in `drizzle/`. Migrations are applied automatically on start.
- Docker: `docker compose up -d --build` (single `app` service, SQLite in the `data` volume at `/data`).

## Layout

`src/server.ts` (entry), `src/app.ts` (`createApp(deps)`), `src/config.ts` (`loadConfig(env)`; all env vars with defaults live here and in `.env.example`), `src/errors.ts`, `src/routes/`, `src/services/`, `src/realtime/signaling.ts`, `src/middleware/`, `src/db/`, `src/lib/`, `drizzle/`, `public/`, `test/`.

API errors are always JSON `{ "error": { "code", "message" } }`.

## Architecture notes

- **One key space.** Live (direct) keys and stored-transfer keys come from the same alphabet (`23456789ABCDEFGHJKMNPQRSTUVWXYZ`, length `KEY_LENGTH`, case-insensitive input) and are generated so they never collide. `signaling` asks `transfers.hasReadyKey` to avoid stored keys; a join on a stored key answers `not-live`.
- **Upload token vs key.** Creating a transfer returns `transferId` and a secret `uploadToken` (only its sha256 is stored), sent as `X-Upload-Token` on chunk PUTs and `complete`. The public `key` is created at `complete` (or is the live key, when a fallback upload keeps it) and only grants downloading. Never use one in place of the other.
- **Chunk flow.** `POST /api/transfers` (file list, optional password) then `PUT /api/transfers/:id/files/:fileId/chunks/:index` per chunk (raw body streamed to disk, no body parser) then `POST /api/transfers/:id/complete`. Chunk size is `CHUNK_MB` (max 95, under Cloudflare's 100 MB request limit). Per-upload state (received chunks, password) is in memory; a restart mid-upload gives `upload_lost`. Abandoned uploads are discarded `UPLOAD_ABANDON_MINUTES` after their last successfully written chunk (failed PUTs do not refresh it). Each upload state remembers its creator's IP (`ipKeyGenerator`, IPv6 by /56); one IP may reserve at most `MAX_TRANSFER_MB` in unfinished uploads, else `429 too_many_uploads`.
- **Passwords and encryption.** Hashes are `scrypt$<saltHex>$<hashHex>`. A transfer password is never stored; files are encrypted with AES-256-GCM using a key derived from it. `POST /api/transfers/:key/unlock` returns a stateless grant token (sealed with `APP_SECRET`, carries the file key, 15 min, bound to the transfer), passed as `?grant=` on file and zip downloads. Without `APP_SECRET`, grants and sessions reset on restart.
- **Downloads.** Always attachments, `nosniff`, `no-store`. Streams are destroyed, not ended, on error so a broken download never looks complete. Zip is a stored (uncompressed) archive built entry by entry in `services/downloads.ts`.
- **Signaling (`/ws`).** JSON messages. Sender sends `host`, gets `hosted` with `key`, `liveToken`, `iceServers`. Receiver sends `join` with a key and gets `joined` (or `not-found`, `not-live`, `busy`). The hub then relays `signal` messages verbatim and sends `peer-joined`, `peer-left`, `expired`, `switch-to-download`. It holds no file data. A room lives as long as its sender's socket. The sender can fall back to upload by passing `liveKey` + `liveToken` to `complete`, which claims the room and tells the receiver to switch to download.
- **Rate limits.** `WINDOWS` in `src/middleware/rateLimits.ts` (`auth`, `lookup`, `miss`, `upload`, `ws`). `miss` counts only failed requests on key routes, and the hub applies the same limit to failed WebSocket joins. Per-IP limits need `TRUST_PROXY` behind a proxy.
- **Config in production.** `BASE_URL` (otherwise share URLs come from the `Host` header), `TRUST_PROXY`, `COOKIE_SECURE`, `APP_SECRET`.

## Testing

- `test/helpers.ts` exports `makeTestApp()`: a real app on a temp data dir and random port, with injectable `now`, config env and rate limits. Use it for new tests.
- `public/js/upload.js` and `public/js/direct.js` are pure modules and are imported by the Node tests. Keep them DOM-free (no `document`, `window`, `localStorage` at import or in their logic).
- No file under `public/` may mention other products (checked in `test/frontend.test.ts`).

## Conventions

- Never describe the project as an alternative to, or compare it with, another product.
- Commit messages: single line, lowercase prefix `add:`, `update:`, `fix:`, `delete:` or `docs:`.
