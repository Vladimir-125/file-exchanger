const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { hashPassword, verifyPassword, isLegacyHash, encryptToFile, decryptStream } = require('../src/security');
const { safeFileName, parseKey } = require('../src/fileStore');
const { formatDuration } = require('../src/routes/files');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-unit-'));
const readAll = async (stream) => {
	const chunks = [];
	for await (const c of stream) chunks.push(c);
	return Buffer.concat(chunks);
};

test('scrypt hashes verify and reject wrong passwords', async () => {
	const h = await hashPassword('hunter22');
	assert.match(h, /^scrypt\$/);
	assert.equal(isLegacyHash(h), false);
	assert.equal(await verifyPassword('hunter22', h), true);
	assert.equal(await verifyPassword('hunter23', h), false);
	assert.notEqual(await hashPassword('hunter22'), h, 'salted');
});

test('legacy sha256(salt + password) hashes still verify', async () => {
	const legacy = crypto.createHash('sha256').update('abc' + 'pw').digest('hex');
	assert.equal(isLegacyHash(legacy), true);
	assert.equal(await verifyPassword('pw', legacy, 'abc'), true);
	assert.equal(await verifyPassword('pw', legacy, ''), false);
	assert.equal(await verifyPassword('pw', ''), false);
});

test('encrypt/decrypt round trip', async () => {
	const file = path.join(tmp, 'a.enc');
	const data = crypto.randomBytes(200_000);
	await encryptToFile(data, 'pw', file);
	assert.equal(fs.readFileSync(file).subarray(0, 4).toString(), 'FXE2');
	assert.deepEqual(await readAll(await decryptStream(file, 'pw')), data);
});

test('tampered or wrong-password ciphertext fails', async () => {
	const file = path.join(tmp, 'b.enc');
	await encryptToFile(Buffer.from('hello world'), 'pw', file);
	await assert.rejects(readAll(await decryptStream(file, 'wrong')));
	const buf = fs.readFileSync(file);
	buf[40] ^= 1;
	fs.writeFileSync(file, buf);
	await assert.rejects(readAll(await decryptStream(file, 'pw')));
});

test('legacy CBC files decrypt', async () => {
	const file = path.join(tmp, 'legacy.enc');
	const iv = crypto.randomBytes(16);
	const key = crypto.createHash('sha256').update('pw').digest();
	const cipher = crypto.createCipheriv('aes256', key, iv);
	const body = Buffer.concat([cipher.update(zlib.gzipSync(Buffer.from('old file'))), cipher.final()]);
	fs.writeFileSync(file, Buffer.concat([iv, body]));
	assert.equal((await readAll(await decryptStream(file, 'pw'))).toString(), 'old file');
});

test('safeFileName strips paths and unsafe characters', () => {
	assert.equal(safeFileName('../../etc/passwd'), 'passwd');
	assert.equal(safeFileName('..\\..\\win.ini'), 'win.ini');
	assert.equal(safeFileName('.hidden'), 'hidden');
	assert.equal(safeFileName('a<b>:c?.txt'), 'a_b__c_.txt');
	assert.equal(safeFileName('тест.txt'), 'тест.txt');
	assert.equal(safeFileName(''), 'file');
	assert.equal(safeFileName('..'), 'file');
});

test('parseKey accepts only digits', () => {
	assert.equal(parseKey('1234'), 1234);
	assert.equal(parseKey(1234), 1234);
	assert.equal(parseKey('1234 '), null);
	assert.equal(parseKey('12a'), null);
	assert.equal(parseKey(undefined), null);
	assert.equal(parseKey(['1234']), null);
});

test('formatDuration', () => {
	assert.equal(formatDuration(24 * 3600), '24:00:00');
	assert.equal(formatDuration(3725), '01:02:05');
});
