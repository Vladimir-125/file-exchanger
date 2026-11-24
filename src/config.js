const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ quiet: true });

const env = process.env;

let sessionSecret = env.SESSION_SECRET;
if (!sessionSecret) {
	sessionSecret = crypto.randomBytes(32).toString('hex');
	console.warn('SESSION_SECRET is not set; using a random one (sessions reset on restart).');
}

// '' / 'false' / '0' -> off, a number -> that many proxy hops, 'true' -> 1 hop
function parseTrustProxy(value) {
	const v = String(value || '').trim().toLowerCase();
	if (!v || v === 'false' || v === '0') return false;
	if (/^\d+$/.test(v)) return Number(v);
	if (v === 'true') return 1;
	return v; // e.g. 'loopback' or an IP/subnet list
}

module.exports = {
	port: Number(env.PORT) || 3000,
	baseUrl: env.BASE_URL || '',
	trustProxy: parseTrustProxy(env.TRUST_PROXY),
	cookieSecure: env.COOKIE_SECURE === 'true',
	sessionSecret,

	uploadsDir: path.resolve(env.UPLOADS_DIR || path.join(__dirname, '..', 'uploads')),
	viewsDir: path.join(__dirname, '..', 'views'),
	publicDir: path.join(__dirname, '..', 'public'),
	maxUploadBytes: (Number(env.MAX_UPLOAD_MB) || 100) * 1024 * 1024,

	// how long uploaded files are kept
	storeSeconds: (Number(env.STORE_HOURS) || 24) * 60 * 60,
	cleanupIntervalMs: 60 * 1000,
	// number of digits in a download key
	keyLen: 4,

	db: {
		host: env.MYSQL_HOST || 'localhost',
		port: Number(env.MYSQL_PORT) || 3306,
		user: env.MYSQL_USER,
		password: env.MYSQL_PASSWORD,
		database: env.MYSQL_DATABASE
	},

	mail: {
		user: env.EMAIL,
		pass: env.PASSWD
	}
};
