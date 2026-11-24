# CLAUDE.md

"Send me file": Express 5 + MySQL file-sharing app. Uploads get a 4-digit key and QR code; optional password encrypts the file (AES-256-GCM, scrypt key) at rest. Frontend is static jQuery HTML in `views/` + `public/`.

## Commands

- `npm start` — run server (reads `.env`)
- `npm test` — node:test; `test/app.test.js` needs MySQL from `.env`, else skips
- `docker compose up -d --build` — app + MySQL

## Architecture notes

- `src/fileStore.js` keeps an in-memory `Map` of the `files` table; it is the source of truth for key lookups at runtime. Files live in `uploads/<key>/<name>` (`.enc` suffix when encrypted).
- `src/security.js` verifies both new `scrypt$salt$hash` hashes and legacy unsalted/salted sha256 hashes; legacy user hashes are upgraded on login. Decryption also supports the legacy AES-CBC file format (no `FXE2` header).
- Sessions are stored in MySQL (`sessions` table, auto-created by express-mysql-session).
- `createApp` takes its dependencies (db, store, mailer, config) so tests can inject a fake mailer and temp uploads dir.
- `overrides.mysql2` in package.json forces express-mysql-session onto the patched mysql2.
