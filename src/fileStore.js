// Uploaded files: an in-memory index backed by the `files` table and the uploads directory.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { hashPassword, encryptToFile } = require('./security');

// keep only the base name and drop characters that are unsafe in file names
function safeFileName(name) {
	let base = path.basename(String(name || '').replace(/\\/g, '/'));
	base = base.replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '_').replace(/^\.+/, '').slice(0, 200);
	return base || 'file';
}

function parseKey(rawKey) {
	if (typeof rawKey !== 'string' && typeof rawKey !== 'number') return null;
	const s = String(rawKey);
	return /^\d{1,10}$/.test(s) ? Number(s) : null;
}

function createFileStore({ db, uploadsDir, keyLen, storeSeconds }) {
	let records = new Map(); // file_id -> { file_id, creation_date, password_hash }
	const pending = new Set(); // keys reserved by uploads still being written

	async function load() {
		const [rows] = await db.query('select * from files');
		records = new Map(rows.map((r) => [r.file_id, r]));
		await fs.promises.mkdir(uploadsDir, { recursive: true });
	}

	function newKey() {
		const min = 10 ** (keyLen - 1);
		if (records.size + pending.size >= min * 9) throw new Error('No free download keys left');
		while (true) {
			const id = crypto.randomInt(min, min * 10);
			if (!records.has(id) && !pending.has(id)) return id;
		}
	}

	async function save({ buffer, originalname, password }) {
		const record = { file_id: newKey(), creation_date: new Date(), password_hash: '' };
		pending.add(record.file_id); // reserve the key; not visible to find() until complete

		try {
			const dir = path.join(uploadsDir, String(record.file_id));
			await fs.promises.mkdir(dir, { recursive: true });
			const name = safeFileName(originalname);
			if (password) {
				await encryptToFile(buffer, password, path.join(dir, name + '.enc'));
				record.password_hash = await hashPassword(password);
			} else {
				await fs.promises.writeFile(path.join(dir, name), buffer);
			}
			await db.query('insert into files (file_id, creation_date, password_hash) values (?, ?, ?)',
				[record.file_id, record.creation_date, record.password_hash]);
			records.set(record.file_id, record);
			return record;
		} catch (err) {
			await remove(record.file_id).catch(() => {});
			throw err;
		} finally {
			pending.delete(record.file_id);
		}
	}

	function find(rawKey) {
		const key = parseKey(rawKey);
		return key === null ? undefined : records.get(key);
	}

	// path of the stored file for a record
	async function filePath(record) {
		const folder = path.join(uploadsDir, String(record.file_id));
		const files = await fs.promises.readdir(folder);
		if (files.length === 0) throw new Error('Upload folder is empty');
		return path.join(folder, files[0]);
	}

	async function remove(fileId) {
		records.delete(fileId);
		await fs.promises.rm(path.join(uploadsDir, String(fileId)), { recursive: true, force: true });
		await db.query('delete from files where file_id = ?', [fileId]);
	}

	async function deleteExpired(now = Date.now()) {
		const expired = [...records.values()].filter(
			(r) => (now - new Date(r.creation_date).getTime()) / 1000 > storeSeconds);
		for (const r of expired) {
			try {
				await remove(r.file_id);
				console.log(`File ${r.file_id} has expired and was deleted`);
			} catch (err) {
				console.error(`Failed to delete file ${r.file_id}:`, err.message);
			}
		}
		return expired.length;
	}

	return { load, save, find, filePath, remove, deleteExpired };
}

module.exports = { createFileStore, safeFileName, parseKey };
