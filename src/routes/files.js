const express = require('express');
const path = require('path');
const multer = require('multer');
const { pipeline } = require('stream');
const { verifyPassword, decryptStream } = require('../security');

const NOT_FOUND_HTML = '<script>alert(\'File does not exist!\');document.location.href="/";</script>';

function formatDuration(seconds) {
	const pad = (n) => String(n).padStart(2, '0');
	return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
}

// page that asks for the password and re-submits the download as POST
function passwordPromptPage(fileId) {
	return `<!DOCTYPE html>
<html>
<head></head>
<body>
	<script>
		var form = document.createElement("form");
		var key = document.createElement("input");
		var pass = document.createElement("input");
		key.value = ${JSON.stringify(String(fileId))};
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
</html>`;
}

// serve relative to the file's own folder so dot-directories higher up the path don't trip `send`
function sendPlain(res, filePath) {
	res.download(path.basename(filePath), { root: path.dirname(filePath) });
}

function fileRoutes({ store, config, limiter, uploadLimiter }) {
	const router = express.Router();
	const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadBytes, files: 1 } });
	const storeTime = formatDuration(config.storeSeconds);

	router.post('/uploadfile', uploadLimiter, upload.single('file'), async (req, res) => {
		if (!req.file) return res.status(400).end('Please upload a file');
		const password = req.body?.password ? String(req.body.password) : '';
		const record = await store.save({
			buffer: req.file.buffer,
			// multer decodes multipart file names as latin1
			originalname: Buffer.from(req.file.originalname, 'latin1').toString('utf8'),
			password
		});
		res.json({ key: record.file_id, time: storeTime });
	});

	router.post('/validate', limiter, async (req, res) => {
		const record = store.find(req.body?.key);
		const passwd = req.body?.password;

		if (!record) return res.end('isnx');
		if (!record.password_hash) return res.end('ok');
		if (passwd === undefined) return res.end('enc');
		res.end((await verifyPassword(String(passwd), record.password_hash)) ? 'ok' : 'wrongpass');
	});

	router.post('/download', limiter, async (req, res) => {
		const record = store.find(req.body?.key);
		const passwd = req.body?.password;
		if (!record) return res.end(NOT_FOUND_HTML);

		const filePath = await store.filePath(record);
		if (!record.password_hash) return sendPlain(res, filePath);
		if (passwd === undefined) return res.end('Enter password');
		if (!(await verifyPassword(String(passwd), record.password_hash))) {
			return res.end('<script>alert(\'Wrong password!\')</script>');
		}

		const plain = await decryptStream(filePath, String(passwd));
		const filename = path.basename(filePath).replace(/\.enc$/, '');
		res.attachment(filename); // sets Content-Disposition (non-ASCII safe) and Content-Type
		// pipeline destroys the file/decipher streams if the client disconnects
		pipeline(plain, res, (err) => {
			if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.error('Decrypt error:', err.message);
		});
	});

	router.get('/download', limiter, async (req, res) => {
		const record = store.find(req.query.key);
		if (!record) return res.end(NOT_FOUND_HTML);
		if (record.password_hash) return res.end(passwordPromptPage(record.file_id));
		sendPlain(res, await store.filePath(record));
	});

	return router;
}

module.exports = { fileRoutes, formatDuration };
