import express, { Router, type Request } from 'express';
import { z } from 'zod';
import type { Deps } from '../app.ts';
import { HttpError } from '../errors.ts';
import type { RateLimits } from '../middleware/rateLimits.ts';

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
const INDEX = /^\d{1,9}$/;

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

  return router;
}
