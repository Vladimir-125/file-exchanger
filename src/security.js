// Password hashing and file encryption helpers.
const crypto = require('crypto');
const fs = require('fs');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

const scryptAsync = (password, salt, keylen) =>
	new Promise((resolve, reject) =>
		crypto.scrypt(password, salt, keylen, (err, key) => (err ? reject(err) : resolve(key))));

// ---------------------------------------------------------------- passwords

// Returns "scrypt$<saltHex>$<hashHex>".
async function hashPassword(password) {
	const salt = crypto.randomBytes(16);
	const hash = await scryptAsync(String(password), salt, 64);
	return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function safeEqualHex(a, b) {
	const ba = Buffer.from(a, 'hex');
	const bb = Buffer.from(b, 'hex');
	return ba.length === bb.length && ba.length > 0 && crypto.timingSafeEqual(ba, bb);
}

// Verifies against a scrypt hash, or a legacy sha256(legacySalt + password) hex digest.
async function verifyPassword(password, stored, legacySalt = '') {
	if (typeof password !== 'string' || !stored) return false;
	if (stored.startsWith('scrypt$')) {
		const [, saltHex, hashHex] = stored.split('$');
		const hash = await scryptAsync(password, Buffer.from(saltHex, 'hex'), hashHex.length / 2);
		return safeEqualHex(hash.toString('hex'), hashHex);
	}
	const legacy = crypto.createHash('sha256').update(legacySalt + password).digest('hex');
	return safeEqualHex(legacy, stored);
}

const isLegacyHash = (stored) => !String(stored).startsWith('scrypt$');

// ---------------------------------------------------------- file encryption
//
// Format v2: "FXE2" | salt(16) | iv(12) | AES-256-GCM(gzip(data)) | tag(16)
// Key = scrypt(password, salt).
// Legacy format: iv(16) | AES-256-CBC(gzip(data)), key = sha256(password).

const MAGIC = Buffer.from('FXE2');
const HEADER_LEN = MAGIC.length + 16 + 12;
const TAG_LEN = 16;

async function encryptToFile(buffer, password, filePath) {
	const salt = crypto.randomBytes(16);
	const iv = crypto.randomBytes(12);
	const key = await scryptAsync(password, salt, 32);
	const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
	const out = fs.createWriteStream(filePath);
	out.write(Buffer.concat([MAGIC, salt, iv]));
	await pipeline(Readable.from([buffer]), zlib.createGzip(), cipher, out, { end: false });
	await new Promise((resolve, reject) => out.end(cipher.getAuthTag(), (err) => (err ? reject(err) : resolve())));
}

async function readBytes(filePath, start, length) {
	const fh = await fs.promises.open(filePath, 'r');
	try {
		const buf = Buffer.alloc(length);
		const { bytesRead } = await fh.read(buf, 0, length, start);
		return buf.subarray(0, bytesRead);
	} finally {
		await fh.close();
	}
}

// Returns a readable stream of the decrypted file contents.
async function decryptStream(filePath, password) {
	const { size } = await fs.promises.stat(filePath);
	const header = await readBytes(filePath, 0, HEADER_LEN);

	if (header.length === HEADER_LEN && header.subarray(0, 4).equals(MAGIC)) {
		const salt = header.subarray(4, 20);
		const iv = header.subarray(20, 32);
		const tag = await readBytes(filePath, size - TAG_LEN, TAG_LEN);
		const key = await scryptAsync(password, salt, 32);
		const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
		decipher.setAuthTag(tag);
		const body = fs.createReadStream(filePath, { start: HEADER_LEN, end: size - TAG_LEN - 1 });
		return chain(body, decipher, zlib.createGunzip());
	}

	// legacy CBC format
	const iv = header.subarray(0, 16);
	const key = crypto.createHash('sha256').update(password).digest();
	const decipher = crypto.createDecipheriv('aes256', key, iv);
	const body = fs.createReadStream(filePath, { start: 16 });
	return chain(body, decipher, zlib.createUnzip());
}

// Pipes streams together and forwards errors to the last one.
function chain(...streams) {
	const last = streams[streams.length - 1];
	for (let i = 0; i < streams.length - 1; i++) {
		streams[i].on('error', (err) => last.destroy(err));
		streams[i].pipe(streams[i + 1]);
	}
	return last;
}

module.exports = { hashPassword, verifyPassword, isLegacyHash, encryptToFile, decryptStream };
