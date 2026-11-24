import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp, type Deps } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { openDb } from '../src/db/client.ts';
import { createRateLimits, type LimitName } from '../src/middleware/rateLimits.ts';
import { createSignaling, type SignalingHub } from '../src/realtime/signaling.ts';
import type { Mail } from '../src/services/mailer.ts';
import { createTransferService, type TransferService } from '../src/services/transfers.ts';

export type TestApp = {
  base: string;
  mail: Mail[];
  deps: Deps;
  signaling: SignalingHub;
  server: http.Server;
  close(): Promise<void>;
};

export async function makeTestApp(
  opts: {
    now?: () => number;
    configEnv?: Record<string, string>;
    rateLimits?: Partial<Record<LimitName, number>>;
    heartbeatMs?: number;
  } = {},
): Promise<TestApp> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-test-'));
  const config = loadConfig({
    APP_SECRET: 'ab'.repeat(32),
    DATA_DIR: dataDir,
    BASE_URL: '',
    ...opts.configEnv,
  });
  const { db, close: closeDb } = openDb(config.dataDir);
  const mail: Mail[] = [];
  const now = opts.now ?? Date.now;
  const big = { auth: 1e6, lookup: 1e6, miss: 1e6, upload: 1e6, ws: 1e6 };
  const limits = { ...big, ...opts.rateLimits };
  // signaling and transfers need each other: the closure reads `transfers` only once both exist
  let transfers: TransferService;
  const signaling = createSignaling({
    config,
    now,
    isStoredKey: (k) => transfers.hasReadyKey(k),
    rateLimitPerHour: limits.ws,
    joinMissPerWindow: limits.miss,
    heartbeatMs: opts.heartbeatMs,
  });
  transfers = createTransferService({ db, config, now, signaling });
  const deps: Deps = {
    config,
    db,
    mailer: { send: async (msg) => void mail.push(msg) },
    now,
    transfers,
  };
  const app = createApp(deps, createRateLimits(limits));
  const server = http.createServer(app);
  signaling.attach(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    base: `http://127.0.0.1:${port}`,
    mail,
    deps,
    signaling,
    server,
    async close() {
      signaling.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      closeDb();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** fetch wrapper that stores set-cookie and replays it; redirects are not followed. */
export function cookieJar() {
  const cookies = new Map<string, string>();
  return {
    cookie: (name: string) => cookies.get(name),
    async fetch(url: string, init: RequestInit = {}): Promise<Response> {
      const headers = new Headers(init.headers);
      if (cookies.size) headers.set('cookie', [...cookies].map(([k, v]) => `${k}=${v}`).join('; '));
      const res = await fetch(url, { redirect: 'manual', ...init, headers });
      for (const line of res.headers.getSetCookie()) {
        const [pair, ...attrs] = line.split(';').map((s) => s.trim());
        const eq = pair.indexOf('=');
        const name = pair.slice(0, eq);
        const expired = attrs.some((a) => {
          const [k, v] = a.split('=');
          const key = k.toLowerCase();
          return (key === 'max-age' && Number(v) <= 0) || (key === 'expires' && Date.parse(v) <= Date.now());
        });
        if (expired) cookies.delete(name);
        else cookies.set(name, pair.slice(eq + 1));
      }
      return res;
    },
  };
}

export const postJson = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
