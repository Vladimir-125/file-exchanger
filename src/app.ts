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
import type { Mailer } from './services/mailer.ts';

export type Deps = { config: Config; db: Db; mailer: Mailer; now: () => number };

const publicDir = fileURLToPath(new URL('../public', import.meta.url));
const KEY_PATH = /^[A-Za-z0-9-]{4,16}$/;

export function createApp(deps: Deps, limits: RateLimits = createRateLimits()): express.Express {
  const { config } = deps;
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

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
  const api = [configRouter(deps), auth.api];
  app.use('/api', ...api);
  app.use(auth.confirm);

  app.use(express.static(publicDir));
  app.get('/:key', (req, res, next) => {
    if (!KEY_PATH.test(String(req.params.key))) return next();
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  app.use(errorMiddleware);
  return app;
}
