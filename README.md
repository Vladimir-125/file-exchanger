# File Exchanger

A small self-hosted, ad-free service for sending files. No trackers, no analytics, no third-party scripts: everything the page needs is served from this app.

- **Send with a key, link or QR code.** Pick files, get a short key (6 characters by default), a link and a QR code. The receiver types the key or opens the link.
- **Direct transfer.** The sender can keep the page open and the file goes straight to the receiver over WebRTC, without being stored on the server. If a direct connection cannot be made, the sender's browser falls back to uploading the file instead.
- **Stored transfers.** Uploaded files are kept for 24 hours by default and then removed.
- **Protected files.** Signed-in users can add a password to a transfer. Files are then encrypted at rest (AES-256-GCM, key derived from the password with scrypt) and the password is never stored. The receiver enters the password to download.
- **Accounts.** Sign-up with email confirmation. An account lists and deletes its own transfers and can set passwords. Sending and receiving without an account is possible.

Stack: Node 22, TypeScript (run with `tsx`), Express 5, SQLite (`better-sqlite3` + Drizzle ORM), `ws` for WebSocket signaling, plain HTML/JS frontend.

## Quick start (Docker)

```
cp .env.example .env     # optional, see Configuration
docker compose up -d --build
```

The app listens on http://localhost:3000 (change the host port with `APP_PORT`). The database and uploaded files live in the `data` volume, mounted at `/data` in the container. There is no separate database service.

For anything public, set `APP_SECRET` (`openssl rand -hex 32`) and `BASE_URL` in `.env`, see the next sections.

## Local development

Requires Node.js 22 (see `.nvmrc`).

```
npm install
cp .env.example .env
npm run dev              # tsx watch, http://localhost:3000
```

`npm start` runs the server once without watching. Data goes to `./data` by default.

If `SMTP_URL` is not set, email is disabled and sign-up confirmation links are printed to the server console.

## Configuration

All settings are environment variables, read from the process environment or a `.env` file (see [.env.example](.env.example)). Sizes in MB are 2^20 bytes.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` (`/data` in Docker) | SQLite database and stored files |
| `BASE_URL` | empty | Public URL used in share links and emails, e.g. `https://files.example.com`. Empty: built from the request `Host` header |
| `APP_SECRET` | empty | 64 hex characters (`openssl rand -hex 32`). Signs sessions and download grants. Empty: random per start, so sessions and grants reset on restart |
| `TRUST_PROXY` | empty (off) | Proxy hops to trust: `true` or a number (one hop is `1`), or an address list such as `loopback` |
| `COOKIE_SECURE` | `false` | Set to `true` when served over HTTPS |
| `TRANSFER_TTL_HOURS` | `24` | Hours a stored transfer stays downloadable |
| `LIVE_KEY_TTL_MINUTES` | `10` | Minutes a direct-transfer key waits for a receiver |
| `KEY_LENGTH` | `6` | Length of share keys (5 to 12) |
| `MAX_FILE_MB` | `2000` | Largest single file |
| `MAX_FILES_PER_TRANSFER` | `20` | Files in one transfer |
| `MAX_TRANSFER_MB` | `4000` | Total size of one transfer |
| `STORAGE_CAP_GB` | `50` | Disk budget for stored transfers; new uploads are refused beyond it |
| `CHUNK_MB` | `50` | Upload chunk size, at most 95 |
| `UPLOAD_ABANDON_MINUTES` | `60` | Minutes before an unfinished upload is discarded |
| `SMTP_URL` | empty | SMTP connection URL, e.g. `smtps://user:pass@smtp.example.com`. Empty: email disabled |
| `MAIL_FROM` | `File Exchanger <no-reply@localhost>` | From header of outgoing mail |
| `TURN_URL` | empty | Optional TURN relay for direct transfers |
| `TURN_USERNAME` | empty | TURN username |
| `TURN_CREDENTIAL` | empty | TURN credential |

### Chunked upload

Browsers upload each file in chunks of `CHUNK_MB` (default 50, at most 95), one request per chunk. This keeps every request below the 100 MB body limit of tunnels and proxies such as Cloudflare, so large files go through. Chunks are written straight to disk, and the server assembles nothing in memory.

### ICE servers (direct transfers)

Direct transfers use WebRTC. By default the only ICE server is the public STUN server `stun:stun.l.google.com:19302`; there is no setting to replace or disable it. Add a TURN relay with `TURN_URL`, `TURN_USERNAME` and `TURN_CREDENTIAL`; it is offered in addition to STUN. Without TURN, some networks (for example behind symmetric NAT) cannot connect directly, and the transfer falls back to uploading the file.

## Running behind a reverse proxy or tunnel

Behind nginx, Caddy, cloudflared or similar:

- `BASE_URL=https://files.example.com`. Required in production. Without it, share URLs and email links are built from the request `Host` header.
- `TRUST_PROXY=1` when exactly one proxy (cloudflared, a single reverse proxy) sits in front, so the per-IP rate limits see real client IPs instead of the proxy's. Leave it empty when the app is exposed directly, otherwise clients can spoof their IP with `X-Forwarded-For`.
- `COOKIE_SECURE=true` once the site is served over HTTPS.
- `APP_SECRET` set, so sessions survive restarts.
- The proxy must pass WebSocket upgrades on `/ws` and allow request bodies of at least `CHUNK_MB`.

### Rate limits

Limits are per client IP and fixed in the code:

| Limiter | Limit | What it covers |
| --- | --- | --- |
| `auth` | 20 per 15 min | sign-up and login |
| `lookup` | 60 per minute | transfer lookups and unlock attempts |
| `miss` | 30 failed requests per 15 min | any route taking a transfer key, and failed WebSocket joins; stops key guessing |
| `upload` | 30 per hour | creating transfers |
| `ws` | 30 per hour | hosting direct transfers over WebSocket |

## Tests

```
npm test
```

Runs `tsc --noEmit`, then the Node test runner over `test/**/*.test.ts`.

## Project layout

```
src/server.ts            entry: config, database, signaling, cleanup timer, graceful shutdown
src/app.ts               Express app: sessions, API routers, static files
src/config.ts            environment parsing
src/routes/              auth, me, config, transfers (upload, download)
src/services/            transfers, downloads (file and zip streams), users, mailer
src/realtime/signaling.ts WebSocket hub pairing sender and receiver
src/middleware/          rate limits, auth guard
src/db/                  Drizzle schema, SQLite client, session store
src/lib/                 keys, crypto, file names
drizzle/                 generated SQL migrations
public/                  static frontend (no build step)
test/                    tests; test/helpers.ts has makeTestApp()
```

## License

Apache-2.0, see [LICENSE](LICENSE).
