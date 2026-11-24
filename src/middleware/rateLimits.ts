import type { RequestHandler } from 'express';
import { ipKeyGenerator, MemoryStore, rateLimit } from 'express-rate-limit';

export type LimitName = 'auth' | 'lookup' | 'miss' | 'upload' | 'ws';
export type RateLimits = Record<LimitName, ReturnType<typeof rateLimit>>;

const clientKey = (ip: string | undefined) => ipKeyGenerator(ip ?? '');

export const WINDOWS: Record<LimitName, { windowMs: number; limit: number }> = {
  auth: { windowMs: 15 * 60_000, limit: 20 },
  lookup: { windowMs: 60_000, limit: 60 },
  // failed requests on any route that takes a transfer key: stops key guessing
  miss: { windowMs: 15 * 60_000, limit: 30 },
  upload: { windowMs: 3600_000, limit: 30 },
  ws: { windowMs: 3600_000, limit: 30 },
};

export function createRateLimits(overrides: Partial<Record<LimitName, number>> = {}): RateLimits {
  const make = (name: LimitName, extra: Partial<Parameters<typeof rateLimit>[0]> = {}) =>
    rateLimit({
      windowMs: WINDOWS[name].windowMs,
      limit: overrides[name] ?? WINDOWS[name].limit,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: (_req, res) => {
        res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests, try again later' } });
      },
      ...extra,
    });
  return { auth: make('auth'), lookup: make('lookup'), miss: makeMiss(make), upload: make('upload'), ws: make('ws') };
}

/**
 * Counts only failed (status >= 400) key requests. skipSuccessfulRequests un-counts a request on the
 * response `finish` event only, so a download the client aborts (status 200, never finished) would
 * stay counted and 30 of them would lock an IP out of every key route. This wraps the limiter and
 * also un-counts, on `close`, any response that sent a status < 400 but did not finish.
 */
function makeMiss(make: (name: LimitName, extra: Parameters<typeof rateLimit>[0]) => ReturnType<typeof rateLimit>) {
  const store = new MemoryStore();
  const limiter = make('miss', {
    store,
    skipSuccessfulRequests: true,
    keyGenerator: (req) => clientKey(req.ip),
  });
  const handler: RequestHandler = (req, res, next) => {
    const key = clientKey(req.ip);
    res.once('close', () => {
      if (!res.writableFinished && res.statusCode < 400) void store.decrement(key);
    });
    return limiter(req, res, next);
  };
  return Object.assign(handler, limiter) as ReturnType<typeof rateLimit>;
}
