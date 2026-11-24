import dotenv from 'dotenv';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db/client.ts';
import { createMailer } from './services/mailer.ts';
import { createTransferService } from './services/transfers.ts';

const CLEANUP_INTERVAL_MS = 60_000;

export async function startServer(
  env: NodeJS.ProcessEnv = process.env,
  opts: { log?: (msg: string) => void } = {},
): Promise<{ url: string; close(): Promise<void> }> {
  const log = opts.log ?? console.log;
  const config = loadConfig(env);
  const { db, close: closeDb } = openDb(config.dataDir);
  const now = Date.now;
  const transfers = createTransferService({ db, config, now });
  const app = createApp({ config, db, mailer: createMailer(config), now, transfers });
  const server = http.createServer(app);

  const runCleanup = () => {
    transfers.cleanup().catch((err) => console.error('cleanup failed:', err));
  };
  runCleanup();
  const timer = setInterval(runCleanup, CLEANUP_INTERVAL_MS);
  timer.unref();

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (err) {
    clearInterval(timer);
    closeDb();
    throw err;
  }
  const url = `http://localhost:${(server.address() as AddressInfo).port}`;
  log(`Listening on ${url}`);

  return {
    url,
    async close() {
      clearInterval(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      closeDb();
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
  const srv = await startServer(process.env);
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
