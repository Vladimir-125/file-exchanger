// Integration tests against a real MySQL (configured via .env / MYSQL_* variables).
// Skipped when the database is unreachable.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../src/config');
const { createPool } = require('../src/db');
const { createFileStore } = require('../src/fileStore');
const { createApp } = require('../src/app');

let db, server, base, skip = false;
const sentMail = [];
const createdKeys = [];
const email = `test-${Date.now()}@example.com`;

before(async () => {
	db = createPool(config.db);
	try {
		await db.query('select 1 from files limit 1');
	} catch (err) {
		skip = `database unavailable: ${err.message}`;
		return;
	}
	const testConfig = {
		...config,
		uploadsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fx-it-')),
		rateLimits: { auth: 1000, key: 1000 }
	};
	const store = createFileStore({ ...testConfig, db });
	await store.load();
	const mailer = { sendMail: async (m) => { sentMail.push(m); } };
	server = createApp({ db, store, mailer, config: testConfig }).listen(0);
	await new Promise((r) => server.once('listening', r));
	base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
	if (server) server.close();
	if (!skip) {
		if (createdKeys.length) await db.query('delete from files where file_id in (?)', [createdKeys]);
		await db.query('delete from users where email = ?', [email]);
		await db.query('delete from not_confirmed where email = ?', [email]);
	}
	await db.end();
});

const form = (fields) => new URLSearchParams(fields);

async function uploadFile(name, content, password) {
	const fd = new FormData();
	fd.append('file', new Blob([content]), name);
	if (password) fd.append('password', password);
	const res = await fetch(`${base}/uploadfile`, { method: 'POST', body: fd });
	assert.equal(res.status, 200);
	const json = await res.json();
	createdKeys.push(json.key);
	return json;
}

test('plain upload and download', async (t) => {
	if (skip) return t.skip(skip);
	const { key, time } = await uploadFile('hello.txt', 'hello plain');
	assert.match(String(key), /^\d{4}$/);
	assert.equal(time, '24:00:00');

	assert.equal(await (await fetch(`${base}/validate`, { method: 'POST', body: form({ key }) })).text(), 'ok');
	const res = await fetch(`${base}/download?key=${key}`);
	assert.equal(await res.text(), 'hello plain');
	assert.match(res.headers.get('content-disposition'), /hello\.txt/);
});

test('encrypted upload with non-ASCII name', async (t) => {
	if (skip) return t.skip(skip);
	const { key } = await uploadFile('тест.txt', 'secret стуфф', 'pw123');
	const validate = (password) => fetch(`${base}/validate`, {
		method: 'POST', body: form(password === undefined ? { key } : { key, password })
	}).then((r) => r.text());

	assert.equal(await validate(), 'enc');
	assert.equal(await validate('nope'), 'wrongpass');
	assert.equal(await validate('pw123'), 'ok');

	const res = await fetch(`${base}/download`, { method: 'POST', body: form({ key, password: 'pw123' }) });
	assert.equal(await res.text(), 'secret стуфф');
	assert.match(res.headers.get('content-disposition'), /filename\*=UTF-8''%D1%82%D0%B5%D1%81%D1%82\.txt/);

	const page = await (await fetch(`${base}/download?key=${key}`)).text();
	assert.match(page, /prompt\('Enter password:'\)/);
});

test('unknown and malformed keys', async (t) => {
	if (skip) return t.skip(skip);
	for (const key of ['0000', '12ab', '1234 ']) {
		assert.equal(await (await fetch(`${base}/validate`, { method: 'POST', body: form({ key }) })).text(), 'isnx');
	}
	assert.match(await (await fetch(`${base}/download?key=abc`)).text(), /File does not exist/);
});

test('signup, confirm, login, secure page', async (t) => {
	if (skip) return t.skip(skip);
	const bad = await fetch(`${base}/signup`, { method: 'POST', body: form({ uname: 'x', uemail: email, upassword: 'short' }) });
	assert.equal(bad.status, 400);

	const signup = await fetch(`${base}/signup`, {
		method: 'POST', body: form({ uname: '<b>Tester</b>', uemail: email.toUpperCase(), upassword: 'password123' })
	});
	assert.equal(signup.status, 200);
	const link = sentMail.at(-1).text.match(/\/confirm\/([0-9a-f]{64})/);
	assert.ok(link, 'confirmation link sent');

	assert.match(await (await fetch(`${base}/confirm/${link[1]}`)).text(), /successfully confirmed/);
	assert.equal((await fetch(`${base}/confirm/${link[1]}`)).status, 404);

	const wrong = await fetch(`${base}/login`, { method: 'POST', body: form({ email, password: 'nope' }), redirect: 'manual' });
	assert.equal(await wrong.text(), 'Wrong email or password!');

	const login = await fetch(`${base}/login`, { method: 'POST', body: form({ email, password: 'password123' }), redirect: 'manual' });
	assert.equal(login.status, 302);
	const cookie = login.headers.get('set-cookie').split(';')[0];

	assert.equal((await fetch(`${base}/secure`, { headers: { cookie }, redirect: 'manual' })).status, 200);
	assert.equal((await fetch(`${base}/secure`, { redirect: 'manual' })).status, 302);
	const name = await fetch(`${base}/name`, { method: 'POST', headers: { cookie } });
	assert.equal(await name.text(), '<b>Tester</b>');
	assert.match(name.headers.get('content-type'), /text\/plain/);
});

test('signup input is not interpreted as SQL', async (t) => {
	if (skip) return t.skip(skip);
	const res = await fetch(`${base}/login`, { method: 'POST', body: form({ email: "' or '1'='1", password: 'x' }) });
	assert.equal(await res.text(), 'Wrong email or password!');
});
