import { Router, type Request } from 'express';
import type { Deps } from '../app.ts';
import { requireUser } from '../middleware/auth.ts';

/** The signed-in user's own data. `GET /me` itself lives in the auth routes. */
export function meRouter(deps: Deps): Router {
  const baseUrlOf = (req: Request) => deps.config.baseUrl || `${req.protocol}://${req.host}`;
  const router = Router();
  router.get('/me/transfers', requireUser, async (req, res) => {
    res.json({ transfers: await deps.transfers.listForOwner(req.session.userId!, baseUrlOf(req)) });
  });
  return router;
}
