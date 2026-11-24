import {
  createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, timingSafeEqual,
} from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { pipeline, Readable } from 'node:stream';
import { pipeline as pipelineAsync } from 'node:stream/promises';

const IV_LEN = 12;
const TAG_LEN = 16;
const SALT_LEN = 16;
const HASH_LEN = 64;
const KEY_LEN = 32;
const HEX = /^(?:[0-9a-f]{2})+$/;

function scryptAsync(secret: string, salt: Buffer, len: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(secret, salt, len, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const hash = await scryptAsync(pw, salt, HASH_LEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const saltHex = parts[1]!;
  const hashHex = parts[2]!;
  if (!HEX.test(saltHex) || !HEX.test(hashHex)) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scryptAsync(pw, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

export function newSaltHex(): string {
  return randomBytes(SALT_LEN).toString('hex');
}

export function deriveFileKey(password: string, saltHex: string): Promise<Buffer> {
  return scryptAsync(password, Buffer.from(saltHex, 'hex'), KEY_LEN);
}

export async function encryptFile(src: string, dest: string, key: Buffer): Promise<void> {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  async function* body(): AsyncGenerator<Buffer> {
    yield iv;
    for await (const chunk of createReadStream(src)) yield cipher.update(chunk as Buffer);
    cipher.final();
    yield cipher.getAuthTag();
  }
  await pipelineAsync(Readable.from(body(), { objectMode: false }), createWriteStream(dest));
}

export async function decryptStream(path: string, key: Buffer): Promise<Readable> {
  const iv = Buffer.alloc(IV_LEN);
  const tag = Buffer.alloc(TAG_LEN);
  const fh = await open(path, 'r');
  let size: number;
  try {
    size = (await fh.stat()).size;
    if (size < IV_LEN + TAG_LEN) throw new Error('encrypted file too short');
    await fh.read(iv, 0, IV_LEN, 0);
    await fh.read(tag, 0, TAG_LEN, size - TAG_LEN);
  } finally {
    await fh.close();
  }
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const bodyEnd = size - TAG_LEN;
  const source: Readable =
    bodyEnd === IV_LEN
      ? Readable.from([])
      : createReadStream(path, { start: IV_LEN, end: bodyEnd - 1 });
  // pipeline tears down every stream (closing the fd) when the returned one is destroyed or fails
  return pipeline(source, decipher, () => {});
}

export function sealGrant(
  p: { transferId: string; fileKey: Buffer; exp: number },
  secret: Buffer,
): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', secret, iv);
  const json = JSON.stringify({
    transferId: p.transferId,
    fileKey: p.fileKey.toString('hex'),
    exp: p.exp,
  });
  const ct = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, ct, cipher.getAuthTag()]).toString('base64url');
}

export function openGrant(
  token: string,
  secret: Buffer,
  now: number,
): { transferId: string; fileKey: Buffer } | null {
  try {
    const raw = Buffer.from(token, 'base64url');
    if (raw.length < IV_LEN + TAG_LEN) return null;
    const decipher = createDecipheriv('aes-256-gcm', secret, raw.subarray(0, IV_LEN));
    decipher.setAuthTag(raw.subarray(raw.length - TAG_LEN));
    const json = Buffer.concat([
      decipher.update(raw.subarray(IV_LEN, raw.length - TAG_LEN)),
      decipher.final(),
    ]).toString('utf8');
    const p = JSON.parse(json) as { transferId?: unknown; fileKey?: unknown; exp?: unknown };
    if (typeof p.transferId !== 'string' || typeof p.fileKey !== 'string' || typeof p.exp !== 'number') {
      return null;
    }
    if (p.exp <= now) return null;
    return { transferId: p.transferId, fileKey: Buffer.from(p.fileKey, 'hex') };
  } catch {
    return null;
  }
}

export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
