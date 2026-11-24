import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';

export type IceServer = { urls: string | string[]; username?: string; credential?: string };

export type Config = {
  port: number;
  dataDir: string;
  baseUrl: string;
  appSecret: Buffer; // 32 bytes
  trustProxy: boolean | number | string;
  cookieSecure: boolean;
  transferTtlMs: number;
  liveKeyTtlMs: number;
  keyLength: number;
  maxFileBytes: number;
  maxFilesPerTransfer: number;
  maxTransferBytes: number;
  storageCapBytes: number;
  chunkBytes: number;
  uploadAbandonMs: number;
  smtpUrl: string | null;
  mailFrom: string;
  iceServers: IceServer[];
};

const MB = 2 ** 20;
const DEFAULT_STUN = 'stun:stun.l.google.com:19302';
const GB = 2 ** 30;

const num = (def: number, min: number, max = Number.MAX_SAFE_INTEGER) =>
  z.preprocess(
    (v) => (v === undefined || v === '' ? def : Number(v)),
    z.number().finite().min(min).max(max),
  );
const int = (def: number, min: number, max?: number) =>
  z.preprocess(
    (v) => (v === undefined || v === '' ? def : Number(v)),
    z.number().int().min(min).max(max ?? Number.MAX_SAFE_INTEGER),
  );
const str = z.string().optional();

const schema = z.object({
  PORT: int(3000, 0, 65535),
  DATA_DIR: str,
  BASE_URL: str,
  // an empty value (as in a copied .env.example) means unset
  APP_SECRET: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, 'APP_SECRET must be 64 hex characters (openssl rand -hex 32)')
      .optional(),
  ),
  TRUST_PROXY: str,
  COOKIE_SECURE: str,
  TRANSFER_TTL_HOURS: num(24, 0.001),
  LIVE_KEY_TTL_MINUTES: num(10, 0.001),
  KEY_LENGTH: int(6, 5, 12),
  MAX_FILE_MB: num(2000, 0.001),
  MAX_FILES_PER_TRANSFER: int(20, 1),
  MAX_TRANSFER_MB: num(4000, 0.001),
  STORAGE_CAP_GB: num(50, 0.000001),
  CHUNK_MB: num(50, 0.001, 95), // must stay under the reverse-proxy body limit
  UPLOAD_ABANDON_MINUTES: num(60, 0.001),
  SMTP_URL: str,
  MAIL_FROM: str,
  // unlike APP_SECRET, empty is meaningful here: no STUN server at all
  STUN_URLS: str,
  TURN_URL: str,
  TURN_USERNAME: str,
  TURN_CREDENTIAL: str,
});

function parseTrustProxy(v: string | undefined): boolean | number | string {
  const s = (v ?? '').trim();
  if (s === '' || s === 'false' || s === '0') return false;
  if (s === 'true') return 1;
  if (/^\d+$/.test(s)) return Number(s);
  return s;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const e = schema.parse(env);
  const trustProxy = parseTrustProxy(e.TRUST_PROXY);
  const baseUrl = e.BASE_URL ?? '';
  if (trustProxy !== false && baseUrl === '') {
    // links would otherwise be built from forwarded headers, which a client can set
    throw new Error('BASE_URL must be set when TRUST_PROXY is, e.g. BASE_URL=https://files.example.com');
  }

  let appSecret: Buffer;
  if (e.APP_SECRET) {
    appSecret = Buffer.from(e.APP_SECRET, 'hex');
  } else {
    appSecret = randomBytes(32);
    console.warn('APP_SECRET is not set: using a random secret, sessions and download grants reset on restart');
  }

  const iceServers: IceServer[] = [];
  // unset: the default; set (even to empty): exactly the listed servers
  const stun = e.STUN_URLS === undefined ? [DEFAULT_STUN] : e.STUN_URLS.split(',').map((s) => s.trim()).filter(Boolean);
  if (stun.length) iceServers.push({ urls: stun.length === 1 ? stun[0]! : stun });
  if (e.TURN_URL) {
    const turn: IceServer = { urls: e.TURN_URL };
    if (e.TURN_USERNAME) turn.username = e.TURN_USERNAME;
    if (e.TURN_CREDENTIAL) turn.credential = e.TURN_CREDENTIAL;
    iceServers.push(turn);
  }

  return {
    port: e.PORT,
    dataDir: path.resolve(e.DATA_DIR || './data'),
    baseUrl,
    appSecret,
    trustProxy,
    cookieSecure: ['true', '1'].includes((e.COOKIE_SECURE ?? '').trim().toLowerCase()),
    transferTtlMs: Math.floor(e.TRANSFER_TTL_HOURS * 3600e3),
    liveKeyTtlMs: Math.floor(e.LIVE_KEY_TTL_MINUTES * 60e3),
    keyLength: e.KEY_LENGTH,
    maxFileBytes: Math.floor(e.MAX_FILE_MB * MB),
    maxFilesPerTransfer: e.MAX_FILES_PER_TRANSFER,
    maxTransferBytes: Math.floor(e.MAX_TRANSFER_MB * MB),
    storageCapBytes: Math.floor(e.STORAGE_CAP_GB * GB),
    chunkBytes: Math.floor(e.CHUNK_MB * MB),
    uploadAbandonMs: Math.floor(e.UPLOAD_ABANDON_MINUTES * 60e3),
    smtpUrl: e.SMTP_URL || null,
    mailFrom: e.MAIL_FROM || 'File Exchanger <no-reply@localhost>',
    iceServers,
  };
}
