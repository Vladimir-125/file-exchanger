import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import type { Config } from './config.ts';
import type { Db } from './db/client.ts';
import { DrizzleSessionStore } from './db/sessionStore.ts';
import { errorMiddleware } from './errors.ts';
import { createRateLimits, type RateLimits } from './middleware/rateLimits.ts';
import { authRouters } from './routes/auth.ts';
import { configRouter } from './routes/config.ts';
import { meRouter } from './routes/me.ts';
import { transfersRouter } from './routes/transfers.ts';
import type { Mailer } from './services/mailer.ts';
import type { TransferService } from './services/transfers.ts';

export type Deps = { config: Config; db: Db; mailer: Mailer; now: () => number; transfers: TransferService };

const publicDir = fileURLToPath(new URL('../public', import.meta.url));
const KEY_PATH = /^[A-Za-z0-9-]{4,16}$/;

/**
 * Everything comes from this origin. QR codes are data: images, received direct files blob: URLs.
 * ws:/wss: are listed because not every browser lets 'self' cover a same-origin WebSocket.
 */
const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self' ws: wss:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

const securityHeaders: express.RequestHandler = (_req, res, next) => {
  res.set({ 'Content-Security-Policy': CSP, 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
  next();
};

export function createApp(deps: Deps, limits: RateLimits = createRateLimits()): express.Express {
  const { config } = deps;
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.use(securityHeaders);

  app.use(
    session({
      name: 'fx_sid',
      secret: config.appSecret.toString('hex'),
      store: new DrizzleSessionStore(deps.db, deps.now),
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, maxAge: 7 * 24 * 3600_000 },
    }),
  );

  // JSON parsing is applied per route (not globally) so routers can take raw bodies.
  // To add a router: one more entry in `api`.
  const auth = authRouters(deps, limits);
  const api = [configRouter(deps), auth.api, meRouter(deps), transfersRouter(deps, limits)];
  app.use('/api', ...api);
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'Not found' } });
  });
  app.use(auth.confirm);

  app.use(express.static(publicDir));
  app.get('/:key', (req, res, next) => {
    if (!KEY_PATH.test(String(req.params.key))) return next();
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  app.use(errorMiddleware);
  return app;
}
