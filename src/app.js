const express = require('express');
const path = require('path');
const multer = require('multer');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const { authRoutes } = require('./routes/auth');
const { fileRoutes } = require('./routes/files');

function createApp({ db, store, mailer, config, sessionStore }) {
	const app = express();
	if (config.trustProxy) app.set('trust proxy', config.trustProxy);

	app.use(express.urlencoded({ extended: true }));
	app.use(session({
		secret: config.sessionSecret,
		store: sessionStore, // defaults to the in-memory store
		name: 'user_sid',
		resave: false,
		saveUninitialized: false,
		cookie: {
			maxAge: 60 * 60 * 1000, // one hour
			httpOnly: true,
			sameSite: 'lax',
			secure: config.cookieSecure
		}
	}));

	const limits = config.rateLimits || {};
	const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: limits.auth ?? 20, standardHeaders: true, legacyHeaders: false });
	const keyLimiter = rateLimit({ windowMs: 60 * 1000, limit: limits.key ?? 30, standardHeaders: true, legacyHeaders: false });
	const uploadLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: limits.upload ?? 60, standardHeaders: true, legacyHeaders: false });

	app.get('/', (req, res) => res.sendFile(path.join(config.viewsDir, 'index.html')));
	app.use(authRoutes({ db, mailer, config, limiter: authLimiter }));
	app.use(fileRoutes({ store, config, limiter: keyLimiter, uploadLimiter }));
	app.use(express.static(config.publicDir));

	app.use((err, req, res, next) => {
		if (err instanceof multer.MulterError) {
			if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).end('File is too large');
			return res.status(400).end('Invalid upload: ' + err.message);
		}
		console.error(err);
		if (res.headersSent) return res.destroy();
		res.status(500).end('Internal server error');
	});

	return app;
}

module.exports = { createApp };
