import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { startServer } from '../src/server.ts';

test('startServer serves the API and close() frees the port', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-server-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logs: string[] = [];
  const srv = await startServer(
    { PORT: '0', DATA_DIR: dir, APP_SECRET: 'ab'.repeat(32) },
    { log: (m) => logs.push(m) },
  );
  try {
    const res = await fetch(`${srv.url}/api/config`);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { keyLength: number }).keyLength, 6);
    assert.deepEqual(logs, [`Listening on ${srv.url}`]);
  } finally {
    await srv.close();
  }
  await srv.close(); // idempotent
  const port = Number(new URL(srv.url).port);
  await assert.rejects(
    new Promise<void>((resolve, reject) => {
      const s = net.connect(port, '127.0.0.1');
      s.once('connect', () => (s.destroy(), resolve()));
      s.once('error', reject);
    }),
  );
});
