import { Router } from 'express';
import type { Deps } from '../app.ts';

export function configRouter({ config }: Deps): Router {
  const router = Router();
  router.get('/config', (_req, res) => {
    res.json({
      keyLength: config.keyLength,
      chunkBytes: config.chunkBytes,
      maxFileBytes: config.maxFileBytes,
      maxFilesPerTransfer: config.maxFilesPerTransfer,
      maxTransferBytes: config.maxTransferBytes,
      transferTtlMs: config.transferTtlMs,
      iceServers: config.iceServers,
    });
  });
  return router;
}
