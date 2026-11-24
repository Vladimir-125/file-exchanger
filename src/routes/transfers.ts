import { pipeline, type Readable } from 'node:stream';
import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { Deps } from '../app.ts';
import { HttpError } from '../errors.ts';
import { requireUser } from '../middleware/auth.ts';
import type { RateLimits } from '../middleware/rateLimits.ts';
import type { TransferRecord } from '../services/transfers.ts';

const createBody = z.object({
  // the real count limit is config.maxFilesPerTransfer, checked by the service (too_many_files)
  files: z
    .array(z.object({ name: z.string(), size: z.number().int().min(0), mime: z.string().optional() }))
    .min(1)
    .max(10_000),
  password: z.string().min(1).max(200).optional(),
});
const completeBody = z.object({
  liveKey: z.string().max(64).optional(),
  liveToken: z.string().max(200).optional(),
});
const unlockBody = z.object({ password: z.string().min(1).max(200) });
const INDEX = /^\d{1,9}$/;
const SIMPLE_MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

const notFound = () => new HttpError(404, 'not_found', 'Transfer not found');
const grantOf = (req: Request) => (typeof req.query.grant === 'string' ? req.query.grant : undefined);

/** Headers every download carries: always an attachment, never sniffed or cached. */
function downloadHeaders(res: Response, name: string, type: string) {
  res.attachment(name);
  res.set({
    'Content-Type': SIMPLE_MIME.test(type) ? type : 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
  });
}

/**
 * Pipes a download to the client. On any stream error (tampered or truncated file, client gone)
 * the response is destroyed, never ended, so a broken download cannot look complete. Errors are
 * not logged: aborts and auth failures are expected traffic here.
 */
function send(src: Readable, res: Response) {
  pipeline(src, res, (err) => {
    if (err) res.destroy();
  });
}

const tokenOf = (req: Request) => req.get('x-upload-token') ?? '';

export function transfersRouter(deps: Deps, limits: RateLimits): Router {
  const { transfers } = deps;
  const baseUrlOf = (req: Request) => deps.config.baseUrl || `${req.protocol}://${req.host}`;
  const json = express.json({ limit: '1mb' });

  const router = Router();
  router.post('/transfers', limits.upload, json, async (req, res) => {
    const body = createBody.parse(req.body);
    const result = await transfers.create({ ...body, ownerId: req.session.userId });
    res.status(201).json(result);
  });

  // raw body, streamed straight to disk: no body parser on this route
  router.put('/transfers/:transferId/files/:fileId/chunks/:index', async (req, res) => {
    const index = String(req.params.index);
    if (!INDEX.test(index)) throw new HttpError(400, 'bad_chunk', 'Chunk index must be a non-negative integer');
    const length = req.get('content-length');
    try {
      await transfers.writeChunk(
        String(req.params.transferId),
        String(req.params.fileId),
        Number(index),
        tokenOf(req),
        req,
        length === undefined ? undefined : Number(length),
      );
    } catch (err) {
      // an unread body is not drained: close the connection after the error response
      if (!req.complete) res.set('connection', 'close');
      throw err;
    }
    res.status(204).end();
  });

  router.post('/transfers/:transferId/complete', json, async (req, res) => {
    const opts = completeBody.parse(req.body ?? {});
    const ready = await transfers.complete(String(req.params.transferId), tokenOf(req), {
      ...opts,
      baseUrl: baseUrlOf(req),
    });
    res.json(ready);
  });

  const ready = async (req: Request): Promise<TransferRecord> => {
    const record = await transfers.findReady(String(req.params.key));
    if (!record) throw notFound();
    return record;
  };

  router.get('/transfers/:key', limits.lookup, async (req, res) => {
    res.json(transfers.view(await ready(req), grantOf(req)));
  });

  router.post('/transfers/:key/unlock', limits.lookup, json, async (req, res) => {
    const { password } = unlockBody.parse(req.body);
    const grant = await transfers.unlock(String(req.params.key), password);
    res.json({ grant, files: transfers.view(await ready(req), grant).files });
  });

  router.get('/transfers/:key/files/:fileId', async (req, res) => {
    const record = await ready(req);
    const file = await transfers.openFile(record, String(req.params.fileId), grantOf(req));
    downloadHeaders(res, file.name, file.mime);
    // a decrypted stream has no length known up front; a plain file's size is exact
    if (record.transfer.passwordHash === null) res.set('Content-Length', String(file.size));
    send(file.stream, res);
  });

  router.get('/transfers/:key/zip', async (req, res) => {
    const record = await ready(req);
    const zip = transfers.openZip(record, grantOf(req));
    downloadHeaders(res, `${record.transfer.key}.zip`, 'application/zip');
    // keys are plain alphanumerics; quoted exactly as clients expect
    res.set('Content-Disposition', `attachment; filename="${record.transfer.key}.zip"`);
    send(zip, res);
  });

  router.delete('/transfers/:key', requireUser, async (req, res) => {
    await transfers.removeOwned(String(req.params.key), req.session.userId!);
    res.status(204).end();
  });

  return router;
}
