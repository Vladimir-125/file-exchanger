# file-exchanger
	
“Send me file” aims to provide another better and more comfortable way for sending and receiving files between various devises. This platform provides both web and desktop application so that clients would be able to send and receive any files only with the access to the Internet. Users can send files from any device to any other device if they have access to the Internet and a browser. For the convenience of desktop users, I have developed desktop version of “Send me file”. There is two ways of sending a file. 

First, allows you to quickly send any file to the server which stores it some specific amount of time (24 hours by default). The server then provides key (4 digits. Can be increased to any other length later when the number of users reaches a point when generating a new key will take long time) to be used to download the file. It also provides QR code that can be used to download file. QR code has a direct link to download the file.

Second, is secure method. It allows users to send files adding a password to them. The files are sent to the server on a secure https channel and stored in encrypted state on the server. The password used for encrypting the file deleted form the server immediately after encryption. The users are prompted to enter the proper password as well as the key of the file in order to download the file. The system is able to check if user enters the right password. When users follow the link encrypted in QR code, they still prompted to enter the password in case the file was encrypted. 

First simple method does not need any registration process, and anyone can send and receive files without restrictions. The second method, however, requires user registration or installation of a special desktop app. Secure method was designed only for VIP users and later was reduced to simple registration or software installation. Download of both encrypted and not encrypted files can be performed without need of logging to the system.

First simple method does not need any registration process, and anyone can send and receive files without restrictions. The second method, however, requires user registration or installation of a special desktop app. Secure method was designed only for VIP users and later was reduced to simple registration or software installation. Download of both encrypted and not encrypted files can be performed without need of logging to the system.


## Getting Started

### Quick start with Docker

```
cp .env.example .env        # optional: set SESSION_SECRET, EMAIL/PASSWD, ...
docker compose up -d --build
```

The app runs on http://localhost:3000 (change with `APP_PORT`). MySQL and the
uploaded files live in Docker volumes; the schema is loaded on first start.

### Running locally

Requires Node.js 20+ and MySQL 8.

```
npm install
cp .env.example .env        # point MYSQL_* at your database
mysql -u <user> -p <database> < schema.sql
npm start
```

Upgrading an existing database from the old version? Run
`mysql -u <user> -p <database> < migrations/001_widen_password_hash.sql` once:
the new password hashes don't fit the old columns.

If `EMAIL`/`PASSWD` are not set, signup confirmation links are printed to the
server console instead of being emailed. For Gmail use an
[app password](https://myaccount.google.com/apppasswords).

### Configuration

All settings are environment variables (see [.env.example](.env.example)):

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `MYSQL_HOST` / `MYSQL_PORT` / `MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_DATABASE` | | Database connection |
| `SESSION_SECRET` | random per start | Session cookie signing key; set it in production |
| `EMAIL` / `PASSWD` | | Gmail account used for confirmation emails |
| `BASE_URL` | request host | Public URL used in confirmation links |
| `COOKIE_SECURE` / `TRUST_PROXY` | off | Enable when served over HTTPS behind a proxy |
| `MAX_UPLOAD_MB` | `100` | Upload size limit |
| `STORE_HOURS` | `24` | How long files are kept |

### Tests

```
npm test
```

Unit tests always run; the integration tests use the database from `.env` and
are skipped if it is unreachable.

### Project layout

```
server.js            entry point
src/config.js        environment configuration
src/app.js           express app (sessions, rate limits, error handler)
src/routes/auth.js   signup, email confirmation, login
src/routes/files.js  upload, validate, download
src/fileStore.js     file index (MySQL) + uploads directory, expiry
src/security.js      scrypt password hashing, AES-256-GCM file encryption
src/mailer.js        nodemailer (Gmail) or console fallback
views/               HTML pages
public/              static assets
schema.sql           database schema
```

Check out [Demo](http://13.125.60.5/ "Open demo in new tab")
