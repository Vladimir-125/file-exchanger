import dotenv from 'dotenv';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db/client.ts';
import { WINDOWS } from './middleware/rateLimits.ts';
import { createSignaling, type SignalingHub } from './realtime/signaling.ts';
import { createMailer } from './services/mailer.ts';
import { createTransferService, type TransferService } from './services/transfers.ts';

const CLEANUP_INTERVAL_MS = 60_000;

export async function startServer(
  env: NodeJS.ProcessEnv = process.env,
  opts: { log?: (msg: string) => void } = {},
): Promise<{ url: string; close(): Promise<void> }> {
  const log = opts.log ?? console.log;
  const config = loadConfig(env);
  const { db, close: closeDb } = openDb(config.dataDir);
  let timer: NodeJS.Timeout | undefined;
  let server: http.Server;
  let signaling: SignalingHub | undefined;
  try {
    const now = Date.now;
    // signaling and transfers need each other: the closure reads `transfers` only once both exist
    let transfers: TransferService;
    signaling = createSignaling({
      config,
      now,
      isStoredKey: (k) => transfers.hasReadyKey(k),
      rateLimitPerHour: WINDOWS.ws.limit,
      joinMissPerWindow: WINDOWS.miss.limit,
    });
    transfers = createTransferService({ db, config, now, signaling });
    const app = createApp({ config, db, mailer: createMailer(config), now, transfers });
    server = http.createServer(app);
    signaling.attach(server);

    const runCleanup = async () => {
      try {
        await transfers.cleanup();
      } catch (err) {
        console.error('cleanup failed:', err);
      }
    };
    void runCleanup();
    timer = setInterval(() => void runCleanup(), CLEANUP_INTERVAL_MS);
    timer.unref();

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (err) {
    clearInterval(timer);
    signaling?.close();
    closeDb();
    throw err;
  }
  const url = `http://localhost:${(server.address() as AddressInfo).port}`;
  log(`Listening on ${url}`);

  let closing: Promise<void> | undefined;
  return {
    url,
    close() {
      closing ??= (async () => {
        clearInterval(timer);
        signaling!.close(); // upgraded sockets are not closed by closeAllConnections
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        closeDb();
      })();
      return closing;
    },
  };
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  dotenv.config({ quiet: true });
  const srv = await startServer(process.env).catch((err) => {
    console.error(`Failed to start: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
  const stop = () => {
    srv.close().then(
      () => process.exit(0),
      (err) => {
        console.error(err);
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
