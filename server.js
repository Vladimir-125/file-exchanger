// call all the required packages
const express = require('express');
const bodyParser = require('body-parser');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const rimraf = require('rimraf');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const contentDisposition = require('content-disposition'); // non-ASCII file names
const mime = require('mime');

// mysql connection to db (also loads .env)
const connectionPool = require('./connectdb');
const transporter = require('./transporter');
const { hashPassword, verifyPassword, isLegacyHash, encryptToFile, decryptStream } = require('./security');

const app = express();
const db = connectionPool.promise();

// config parameters ----------------------------------------------->

const secInterval = 1;
// file storage time
const storeMinutes = 0;
const storeHours = 24;
const storeTime = '24:00:00';
// file key length
const keyLen = 4;
const port = process.env.PORT || 3000;
const maxUploadBytes = (Number(process.env.MAX_UPLOAD_MB) || 100) * 1024 * 1024;
const uploadsDir = path.join(__dirname, 'uploads');

let sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
	sessionSecret = crypto.randomBytes(32).toString('hex');
	console.warn('SESSION_SECRET is not set; using a random one (sessions reset on restart).');
}

// config parameters <------------------------------------------------

let idDB = []; // in-memory copy of the files table

// init process ----------------------------------------------------->

db.query('select * from files')
	.then(([rows]) => {
		idDB = rows;
		console.log('Database has been loaded on the server!');
	})
	.catch((err) => {
		console.error('Failed to load files table:', err.message);
		process.exit(1);
	});

if (process.env.TRUST_PROXY) app.set('trust proxy', 1);

app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(session({
	secret: sessionSecret,
	name: 'user_sid',
	resave: false,
	saveUninitialized: false,
	cookie: {
		maxAge: 60 * 60 * 1000, // one hour
		httpOnly: true,
		sameSite: 'lax',
		secure: process.env.COOKIE_SECURE === 'true'
	}
}));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
const keyLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });

const loginChecker = (req, res, next) => {
	if (!req.session.logged) return res.redirect('/');
	next();
};

// wraps async handlers so rejections reach the error handler
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// periodically delete expired files
setInterval(() => {
	for (const file of [...idDB]) deleteOld(file);
}, secInterval * 1000);

// init process <------------------------------------------------------

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
app.get('/secure', loginChecker, (req, res) => res.sendFile(__dirname + '/secure.html'));
app.get('/signup', (req, res) => res.sendFile(__dirname + '/statics/signup.html'));

app.post('/signup', authLimiter, wrap(async (req, res) => {
	const uname = String(req.body.uname || '').trim();
	const uemail = String(req.body.uemail || '').trim().toLowerCase();
	const upassword = String(req.body.upassword || '');

	if (!uname || uname.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(uemail) || upassword.length < 8) {
		return res.status(400).end('Please provide a name, a valid email and a password of at least 8 characters.');
	}

	const [existing] = await db.query('select id from users where email = ?', [uemail]);
	if (existing.length > 0) return res.end('You have been already signed up before!');

	const passwordHash = await hashPassword(upassword);
	const confirmToken = crypto.randomBytes(32).toString('hex');
	await db.query(
		'insert into not_confirmed (name, email, salt, password_hash, confirm_url) values (?, ?, ?, ?, ?)',
		[uname, uemail, '', passwordHash, confirmToken]
	);

	const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
	transporter.sendMail({
		from: process.env.EMAIL,
		to: uemail,
		subject: 'Welcome to Send me File',
		text: `Thank you for subscribing on Send me file.
From now on you can use your email to login to our system.
Just follow the link to confirm signup: ${baseUrl}/confirm/${confirmToken}`
	}, (error, info) => {
		if (error) console.error('Email error:', error.message);
		else console.log('Email sent: ' + info.response);
	});

	res.sendFile(__dirname + '/statics/signup-welcome.html');
}));

app.get('/confirm/:token', authLimiter, wrap(async (req, res) => {
	const [rows] = await db.query('select * from not_confirmed where confirm_url = ?', [req.params.token]);
	if (rows.length === 0) {
		return res.status(404).sendFile(__dirname + '/statics/pagenotfound.html');
	}
	const u = rows[0];
	try {
		await db.query(
			'insert into users (name, email, salt, password_hash) values (?, ?, ?, ?)',
			[u.name, u.email, u.salt, u.password_hash]
		);
	} catch (err) {
		if (err.code !== 'ER_DUP_ENTRY') throw err; // already confirmed via another link
	}
	await db.query('delete from not_confirmed where email = ?', [u.email]);
	res.end('You have successfully confirmed your email address!');
}));

// send static files for user
app.use(express.static(__dirname + '/public'));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxUploadBytes, files: 1 } });

app.post('/login', authLimiter, wrap(async (req, res) => {
	const email = String(req.body.email || '').toLowerCase();
	const password = String(req.body.password || '');
	const [rows] = await db.query('select * from users where email = ?', [email]);
	const user = rows[0];

	if (!user || !(await verifyPassword(password, user.password_hash, user.salt))) {
		return res.end('Wrong email or password!');
	}

	if (isLegacyHash(user.password_hash)) {
		// upgrade old sha256 hash
		await db.query('update users set password_hash = ?, salt = ? where id = ?', [await hashPassword(password), '', user.id]);
	}

	req.session.regenerate((err) => {
		if (err) return res.status(500).end('Session error');
		req.session.logged = true;
		req.session.userName = user.name;
		req.session.userId = user.id;
		req.session.userEmail = user.email;
		res.redirect('/secure');
	});
}));

app.post('/name', loginChecker, (req, res) => {
	res.type('text/plain').end(req.session.userName);
});

app.post('/uploadfile', upload.single('file'), wrap(async (req, res) => {
	const file = req.file;
	if (!file) return res.status(400).end('Please upload a file');

	const fdata = createMetadata();
	const dir = createDir(fdata);
	const name = safeFileName(file.originalname);

	if (req.body.password) {
		await encryptToFile(file.buffer, String(req.body.password), path.join(dir, name + '.enc'));
		fdata.password_hash = await hashPassword(String(req.body.password));
	} else {
		await fs.promises.writeFile(path.join(dir, name), file.buffer);
	}

	idDB.push(fdata);
	await db.query('insert into files (file_id, creation_date, password_hash) values (?, ?, ?)',
		[fdata.file_id, fdata.creation_date, fdata.password_hash]);

	// return download key and server store time
	res.json({ key: fdata.file_id, time: storeTime });
}));

// returns the in-memory record for a key, or undefined
function findFile(rawKey) {
	if (!/^\d{1,10}$/.test(String(rawKey || ''))) return undefined;
	const key = Number(rawKey);
	return idDB.find((obj) => obj.file_id === key);
}

async function firstFileIn(fileId) {
	const folder = path.join(uploadsDir, String(fileId));
	const files = await fs.promises.readdir(folder);
	if (files.length === 0) throw new Error('Upload folder is empty');
	return path.join(folder, files[0]);
}

app.post('/validate', keyLimiter, wrap(async (req, res) => {
	const record = findFile(req.body.key);
	const passwd = req.body.password;

	if (!record) return res.end('isnx');
	if (!record.password_hash) return res.end('ok');
	if (passwd === undefined) return res.end('enc');
	res.end((await verifyPassword(String(passwd), record.password_hash)) ? 'ok' : 'wrongpass');
}));

app.post('/download', keyLimiter, wrap(async (req, res) => {
	const record = findFile(req.body.key);
	const passwd = req.body.password;

	if (!record) {
		return res.end('<script>alert(\'File does not exist!\');document.location.href="/";</script>');
	}

	const filePath = await firstFileIn(record.file_id);

	if (!record.password_hash) return res.download(filePath);
	if (passwd === undefined) return res.end('Enter password');
	if (!(await verifyPassword(String(passwd), record.password_hash))) {
		return res.end('<script>alert(\'Wrong password!\')</script>');
	}

	const plain = await decryptStream(filePath, String(passwd));
	const filename = path.basename(filePath).replace(/\.enc$/, '');
	res.setHeader('Content-Disposition', contentDisposition(filename));
	res.setHeader('Content-Type', mime.getType(filename) || 'application/octet-stream');
	plain.on('error', (err) => {
		console.error('Decrypt error:', err.message);
		res.destroy(err);
	});
	plain.pipe(res);
}));

app.get('/download', keyLimiter, wrap(async (req, res) => {
	const record = findFile(req.query.key);
	if (!record) {
		return res.end('<script>alert(\'File does not exist!\');document.location.href="/";</script>');
	}

	if (!record.password_hash) return res.download(await firstFileIn(record.file_id));

	// file has a password: prompt for it and re-submit as POST
	res.end(`<!DOCTYPE html>
<html>
<head></head>
<body>
	<script>
		var form = document.createElement("form");
		var key = document.createElement("input");
		var pass = document.createElement("input");
		key.value = ${JSON.stringify(String(record.file_id))};
		pass.value = prompt('Enter password:');
		key.setAttribute('name', 'key');
		key.style.visibility = "hidden";
		pass.style.visibility = "hidden";
		pass.setAttribute('name', 'password');
		form.setAttribute('method', 'post');
		form.setAttribute('action', '/download');
		form.appendChild(key);
		form.appendChild(pass);
		document.body.appendChild(form).submit();
		setTimeout(()=>{document.location.href="/";}, 1000);
	</script>
</body>
</html>`);
}));

// error handler
app.use((err, req, res, next) => {
	if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
		return res.status(413).end('File is too large');
	}
	console.error(err);
	if (res.headersSent) return res.destroy();
	res.status(500).end('Internal server error');
});

function deleteOld(file) {
	const waitTime = storeMinutes * 60 + storeHours * 60 * 60; // seconds
	const age = (Date.now() - new Date(file.creation_date).getTime()) / 1000;
	if (age <= waitTime) return;

	const index = idDB.indexOf(file);
	if (index > -1) idDB.splice(index, 1);

	rimraf(path.join(uploadsDir, String(file.file_id)), () => console.log('File has been deleted!'));
	db.query('DELETE FROM files WHERE file_id = ?', [file.file_id])
		.catch((err) => console.error('Failed to delete file record:', err.message));
}

function createDir(fdata) {
	const dir = path.join(uploadsDir, String(fdata.file_id));
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

// keep only the base name and drop characters that are unsafe in file names
function safeFileName(name) {
	let base = path.basename(String(name || '').replace(/\\/g, '/'));
	base = base.replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '_').replace(/^\.+/, '').slice(0, 200);
	return base || 'file';
}

function createMetadata() {
	const min = 10 ** (keyLen - 1);
	while (true) {
		const id = crypto.randomInt(min, min * 10);
		if (!idDB.some((obj) => obj.file_id === id)) {
			return { file_id: id, creation_date: new Date(), password_hash: '' };
		}
	}
}

app.listen(port, () => {
	console.log('Running at Port: ' + port);
});
