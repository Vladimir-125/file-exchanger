import { rateLimit } from 'express-rate-limit';

export type LimitName = 'auth' | 'lookup' | 'miss' | 'upload' | 'ws';
export type RateLimits = Record<LimitName, ReturnType<typeof rateLimit>>;

export const WINDOWS: Record<LimitName, { windowMs: number; limit: number }> = {
  auth: { windowMs: 15 * 60_000, limit: 20 },
  lookup: { windowMs: 60_000, limit: 60 },
  // failed requests on any route that takes a transfer key: stops key guessing
  miss: { windowMs: 15 * 60_000, limit: 30 },
  upload: { windowMs: 3600_000, limit: 30 },
  ws: { windowMs: 3600_000, limit: 30 },
};

export function createRateLimits(overrides: Partial<Record<LimitName, number>> = {}): RateLimits {
  const make = (name: LimitName) =>
    rateLimit({
      windowMs: WINDOWS[name].windowMs,
      limit: overrides[name] ?? WINDOWS[name].limit,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      skipSuccessfulRequests: name === 'miss', // only responses with status >= 400 count
      handler: (_req, res) => {
        res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests, try again later' } });
      },
    });
  return { auth: make('auth'), lookup: make('lookup'), miss: make('miss'), upload: make('upload'), ws: make('ws') };
}
