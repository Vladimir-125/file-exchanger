const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { hashPassword, verifyPassword, isLegacyHash } = require('../security');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function requireLogin(req, res, next) {
	if (!req.session.logged) return res.redirect('/');
	next();
}

function authRoutes({ db, mailer, config, limiter }) {
	const router = express.Router();
	const view = (name) => path.join(config.viewsDir, name);

	router.get('/secure', requireLogin, (req, res) => res.sendFile(view('secure.html')));
	router.get('/signup', (req, res) => res.sendFile(view('signup.html')));

	router.post('/signup', limiter, async (req, res) => {
		const uname = String(req.body.uname || '').trim();
		const uemail = String(req.body.uemail || '').trim().toLowerCase();
		const upassword = String(req.body.upassword || '');

		if (!uname || uname.length > 100 || !EMAIL_RE.test(uemail) || upassword.length < 8) {
			return res.status(400).end('Please provide a name, a valid email and a password of at least 8 characters.');
		}

		const [existing] = await db.query('select id from users where email = ?', [uemail]);
		if (existing.length > 0) return res.end('You have been already signed up before!');

		const confirmToken = crypto.randomBytes(32).toString('hex');
		await db.query(
			'insert into not_confirmed (name, email, salt, password_hash, confirm_url) values (?, ?, ?, ?, ?)',
			[uname, uemail, '', await hashPassword(upassword), confirmToken]
		);

		const baseUrl = config.baseUrl || `${req.protocol}://${req.get('host')}`;
		mailer.sendMail({
			to: uemail,
			subject: 'Welcome to Send me File',
			text: `Thank you for subscribing on Send me file.
From now on you can use your email to login to our system.
Just follow the link to confirm signup: ${baseUrl}/confirm/${confirmToken}`
		}).catch((err) => console.error('Email error:', err.message));

		res.sendFile(view('signup-welcome.html'));
	});

	router.get('/confirm/:token', limiter, async (req, res) => {
		const [rows] = await db.query('select * from not_confirmed where confirm_url = ?', [req.params.token]);
		if (rows.length === 0) return res.status(404).sendFile(view('pagenotfound.html'));

		const u = rows[0];
		try {
			await db.query('insert into users (name, email, salt, password_hash) values (?, ?, ?, ?)',
				[u.name, u.email, u.salt, u.password_hash]);
		} catch (err) {
			if (err.code !== 'ER_DUP_ENTRY') throw err; // already confirmed via another link
		}
		await db.query('delete from not_confirmed where email = ?', [u.email]);
		res.end('You have successfully confirmed your email address!');
	});

	router.post('/login', limiter, async (req, res) => {
		const email = String(req.body.email || '').toLowerCase();
		const password = String(req.body.password || '');
		const [rows] = await db.query('select * from users where email = ?', [email]);
		const user = rows[0];

		if (!user || !(await verifyPassword(password, user.password_hash, user.salt))) {
			return res.end('Wrong email or password!');
		}
		if (isLegacyHash(user.password_hash)) {
			// upgrade old sha256 hash
			await db.query('update users set password_hash = ?, salt = ? where id = ?',
				[await hashPassword(password), '', user.id]);
		}

		await new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
		req.session.logged = true;
		req.session.userName = user.name;
		req.session.userId = user.id;
		req.session.userEmail = user.email;
		res.redirect('/secure');
	});

	router.post('/name', requireLogin, (req, res) => {
		res.type('text/plain').end(req.session.userName);
	});

	return router;
}

module.exports = { authRoutes };
